import { getGitContext } from "./git.js";

/**
 * `deterministic: true` omits the wall-clock field. BUILD §5.1 requires the
 * `locate` surface to be byte-identical across runs ("no wall-clock in any
 * scoring path"), so `locate` envelopes must not carry a timestamp; every
 * other capability keeps it.
 */
export function createEnvelope(capability, root, strategy, payload, { deterministic = false } = {}) {
  const git = getGitContext(root);
  return {
    schema: `ai.mentu.navigator.${capability}.v1`,
    capability,
    repository: {
      root,
      gitHead: git.head,
      branch: git.branch,
      dirty: git.dirty
    },
    strategy,
    ...(deterministic ? {} : { generatedAt: new Date().toISOString() }),
    ...payload
  };
}
