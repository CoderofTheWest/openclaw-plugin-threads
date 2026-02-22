const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseProjectsFile, parseDecisionsFile } = require('./lib/projects-reader');
const { buildContext, buildPulse } = require('./lib/context-builder');

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    const next = source[key];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      result[key] = deepMerge(result[key] || {}, next);
    } else {
      result[key] = next;
    }
  }
  return result;
}

function loadConfig(userConfig) {
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
  );
  return deepMerge(defaults, userConfig || {});
}

module.exports = {
  id: 'threads',
  name: 'Project Threads',

  configSchema: {
    jsonSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        projectsFile: { type: ['string', 'null'] },
        decisionsFile: { type: ['string', 'null'] },
        contextInjection: { type: 'object' },
        pulse: { type: 'object' }
      }
    }
  },

  register(api) {
    const config = loadConfig(api.pluginConfig || {});
    if (!config.enabled) return;

    // ── Per-agent state ──────────────────────────────────────────────────

    const agentStates = new Map();

    function getState(agentId) {
      const id = agentId || 'main';
      if (!agentStates.has(id)) {
        agentStates.set(id, {
          agentId: id,
          workspacePath: null,
          pulseQueuedTonight: false,
          lastParsedHash: null
        });
      }
      return agentStates.get(id);
    }

    /**
     * Resolve the workspace directory for an agent from event metadata,
     * cached state, or default convention.
     */
    function resolveWorkspace(state, event) {
      if (event?.metadata?.workspace && !state.workspacePath) {
        state.workspacePath = event.metadata.workspace;
      }
      return state.workspacePath
        || path.join(os.homedir(), '.openclaw',
            state.agentId === 'main' ? 'workspace' : `workspace-${state.agentId}`);
    }

    function getFilePaths(state, event) {
      const workspace = resolveWorkspace(state, event);
      return {
        projects:  config.projectsFile  || path.join(workspace, 'PROJECTS.md'),
        decisions: config.decisionsFile || path.join(workspace, 'DECISIONS.md')
      };
    }

    // ── Hook: before_agent_start (priority 6) ────────────────────────────
    // Inject [ACTIVE PROJECTS] + [ACTIVE CONSTRAINTS] + [OPEN DIRECTIVES]

    api.on('before_agent_start', async (event, ctx) => {
      if (!config.contextInjection?.enabled) return {};

      try {
        const state = getState(ctx.agentId);
        const paths = getFilePaths(state, event);

        const projects  = parseProjectsFile(paths.projects);
        const decisions = parseDecisionsFile(paths.decisions);

        if (!projects && !decisions) return {};

        const block = buildContext(projects, decisions, config.contextInjection);
        if (!block) return {};

        return { prependContext: block };
      } catch (err) {
        api.logger.error(`[Threads] before_agent_start failed: ${err.message}`);
        return {};
      }
    }, { priority: 6 });

    // ── Nightshift: project-pulse ────────────────────────────────────────
    // Send a brief project status via messaging when something changed.

    if (global.__ocNightshift?.registerTaskRunner) {
      global.__ocNightshift.registerTaskRunner('project-pulse', async (task) => {
        try {
          const agentId = task.agentId || 'main';
          const state = getState(agentId);
          const paths = getFilePaths(state, null);

          const projects  = parseProjectsFile(paths.projects);
          const decisions = parseDecisionsFile(paths.decisions);

          if (!projects && !decisions) return;

          // Check if files changed since last pulse (simple content hash)
          const currentHash = hashFiles(paths);
          if (currentHash === state.lastParsedHash) {
            api.logger.info('[Threads] No project changes since last pulse — skipping');
            return;
          }
          state.lastParsedHash = currentHash;

          const pulse = buildPulse(projects, decisions);

          if (config.pulse?.enabled && api.message?.send) {
            await api.message.send({ message: pulse });
            api.logger.info('[Threads] Pulse sent via messaging');
          } else {
            api.logger.info('[Threads] Pulse generated (messaging not available)');
          }
        } catch (err) {
          api.logger.error(`[Threads] pulse failed: ${err.message}`);
        }
      });
    }

    // ── Heartbeat: queue pulse during nightshift ─────────────────────────

    api.on('heartbeat', async (event, ctx) => {
      if (!config.pulse?.enabled) return;
      if (!global.__ocNightshift?.isInOfficeHours?.(ctx.agentId)) return;

      const state = getState(ctx.agentId);
      if (state.pulseQueuedTonight) return;

      global.__ocNightshift.queueTask(ctx.agentId, {
        type: 'project-pulse',
        priority: 20,
        agentId: ctx.agentId
      });
      state.pulseQueuedTonight = true;
      api.logger.info('[Threads] Queued pulse for nightshift');
    });

    // Reset pulse flag when office hours end (check each heartbeat)
    api.on('heartbeat', async (event, ctx) => {
      const state = getState(ctx.agentId);
      if (state.pulseQueuedTonight && !global.__ocNightshift?.isInOfficeHours?.(ctx.agentId)) {
        state.pulseQueuedTonight = false;
      }
    });

    // ── Gateway methods ──────────────────────────────────────────────────

    api.registerGatewayMethod('threads.getState', async ({ params, respond }) => {
      try {
        const state = getState(params?.agentId);
        const paths = getFilePaths(state, null);

        const projects  = parseProjectsFile(paths.projects);
        const decisions = parseDecisionsFile(paths.decisions);

        respond(true, { projects, decisions, paths });
      } catch (err) {
        respond(false, { error: err.message });
      }
    });

    api.registerGatewayMethod('threads.getPulse', async ({ params, respond }) => {
      try {
        const state = getState(params?.agentId);
        const paths = getFilePaths(state, null);

        const projects  = parseProjectsFile(paths.projects);
        const decisions = parseDecisionsFile(paths.decisions);

        const pulse = buildPulse(projects, decisions);
        respond(true, { pulse });
      } catch (err) {
        respond(false, { error: err.message });
      }
    });

    // ── Helpers ──────────────────────────────────────────────────────────

    function hashFiles(paths) {
      let content = '';
      try {
        if (fs.existsSync(paths.projects)) {
          const stat = fs.statSync(paths.projects);
          content += `p:${stat.mtimeMs}:${stat.size}`;
        }
        if (fs.existsSync(paths.decisions)) {
          const stat = fs.statSync(paths.decisions);
          content += `d:${stat.mtimeMs}:${stat.size}`;
        }
      } catch { /* ignore */ }
      return content || 'empty';
    }

    api.logger.info('[Threads] Plugin registered — project context injection + pulse active');
  }
};
