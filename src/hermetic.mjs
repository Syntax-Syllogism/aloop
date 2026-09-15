const DEFAULTS = {
  runtime: 'docker',
  image: null,
  networks: [],
  env: [],
  secrets: [],
};

function normalizeNames(value, field) {
  const names = value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  if (names.some((name) => typeof name !== 'string' || !name)) {
    throw new Error(`Hermetic ${field} must contain non-empty strings.`);
  }
  return [...new Set(names)];
}

function normalizeNetworkNames(value) {
  const networks = normalizeNames(value, 'network names');
  if (networks.includes('none') && networks.length > 1) {
    throw new Error('Hermetic network policy cannot combine "none" with an allowed network.');
  }
  return networks;
}

/** Normalize the run-level defaults without enabling container execution. */
export function normalizeHermeticConfig(value) {
  if (value === undefined || value === null || value === false) return { ...DEFAULTS };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`hermetic` must be an object.');
  }
  const normalized = {
    ...DEFAULTS,
    ...value,
    networks: value.networks ?? value.network ?? DEFAULTS.networks,
  };
  if (typeof normalized.runtime !== 'string' || !normalized.runtime) {
    throw new Error('`hermetic.runtime` must be a non-empty command name.');
  }
  if (normalized.image !== null && (typeof normalized.image !== 'string' || !normalized.image)) {
    throw new Error('`hermetic.image` must be a non-empty image name or null.');
  }
  normalized.networks = normalizeNetworkNames(normalized.networks);
  normalized.env = normalizeNames(normalized.env, 'environment names');
  normalized.secrets = normalizeNames(normalized.secrets, 'secret names');
  delete normalized.network;
  return normalized;
}

/**
 * Resolve a phase's opt-in descriptor against run-level defaults.
 * `undefined` and `false` deliberately mean host execution.
 */
export function resolvePhaseHermetic(value, defaults, phaseKind) {
  if (value === undefined || value === false || value === null) return null;
  if (value !== true && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Phase hermetic execution must be true, false, or an object.');
  }
  const override = value === true ? {} : value;
  const resolved = normalizeHermeticConfig({
    ...defaults,
    ...override,
    ...(override.network !== undefined || override.networks !== undefined
      ? { networks: override.networks ?? override.network }
      : {}),
  });
  if (!resolved.image) {
    throw new Error('Hermetic phases require `hermetic.image` to be configured.');
  }
  if (resolved.secrets.length && phaseKind !== 'publish') {
    throw new Error('Hermetic secrets may only be declared by the publish phase.');
  }
  return resolved;
}

function mountArg(path, mode) {
  return `type=bind,src=${path},dst=${path}${mode === 'ro' ? ',readonly' : ''}`;
}

function uniqueMounts(mounts) {
  const byPath = new Map();
  for (const mount of mounts) {
    const current = byPath.get(mount.path);
    if (!current || (current.mode === 'ro' && mount.mode === 'rw')) byPath.set(mount.path, mount);
  }
  return [...byPath.values()];
}

/**
 * Build a runtime invocation around an adapter command. Paths intentionally
 * stay absolute: each host path is bind-mounted at the same path in the
 * container, so BYO adapters need no container-specific contract.
 */
export function hermeticInvocation({
  settings,
  command,
  args,
  cwd,
  mounts = [],
  env = process.env,
}) {
  const runtimeArgs = ['run', '--rm', '--workdir', cwd];
  const networks = settings.networks.length ? settings.networks : ['none'];
  for (const network of networks) runtimeArgs.push('--network', network);
  for (const mount of uniqueMounts(mounts)) runtimeArgs.push('--mount', mountArg(mount.path, mount.mode));

  const environment = { PATH: env.PATH ?? '/usr/bin:/bin' };
  for (const name of settings.secrets) {
    if (env[name] === undefined) throw new Error(`Hermetic secret "${name}" is not set in the host environment.`);
  }
  for (const name of [...settings.env, ...settings.secrets]) {
    if (env[name] !== undefined) environment[name] = env[name];
  }
  for (const name of Object.keys(environment)) runtimeArgs.push('--env', name);

  runtimeArgs.push(settings.image, command, ...args);
  return {
    command: settings.runtime,
    args: runtimeArgs,
    env: environment,
    policy: {
      runtime: settings.runtime,
      image: settings.image,
      networks: [...settings.networks],
      env: [...settings.env],
      secrets: [...settings.secrets],
    },
  };
}

export function hermeticEnvironment(settings, source = process.env) {
  const environment = { PATH: source.PATH ?? '/usr/bin:/bin' };
  for (const name of settings.secrets) {
    if (source[name] === undefined) throw new Error(`Hermetic secret "${name}" is not set in the host environment.`);
  }
  for (const name of [...settings.env, ...settings.secrets]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

export function hermeticSnapshot(config) {
  const phases = config.resolvedPhases
    .flatMap((phase) => [phase, ...(phase.repair ?? [])])
    .map((phase) => ({
      name: phase.name,
      enabled: Boolean(phase.hermetic),
      ...(phase.hermetic ? {
        runtime: phase.hermetic.runtime,
        image: phase.hermetic.image,
        networks: [...phase.hermetic.networks],
        env: [...phase.hermetic.env],
        secrets: [...phase.hermetic.secrets],
      } : {}),
    }));
  return {
    runtime: config.hermetic.runtime,
    image: config.hermetic.image,
    phases,
  };
}
