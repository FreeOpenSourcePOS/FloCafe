// Pre-commit tasks for the optional local Git hook. Each package runs its own installed Oxfmt
// and Oxlint with its own scope; the task scripts filter the staged file list, so generated and
// excluded artifacts never reach the tools and an empty eligible set is a success.
// CI re-runs the same scopes authoritatively, because a hook can be bypassed.

const EXTENSIONS = 'js,jsx,ts,tsx,mjs,cjs,mts,cts';
const ROOT_TASK = 'node scripts/oxc/format-staged.cjs --package root';
const FRONTEND_TASK = 'node scripts/oxc/format-staged.cjs --package frontend';

// Root files the root formatter scope names explicitly, alongside main/, shared/, scripts/, tests/.
const ROOT_FILES = '{dev-server.js,kill-ports.js,lint-staged.config.mjs,.husky/install.mjs}';

export default {
  [`{main,shared,scripts,tests}/**/*.{${EXTENSIONS}}`]: ROOT_TASK,
  [ROOT_FILES]: ROOT_TASK,
  [`frontend/**/*.{${EXTENSIONS}}`]: FRONTEND_TASK,
};
