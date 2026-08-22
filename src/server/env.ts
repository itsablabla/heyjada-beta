/**
 * Branded environment variable resolution.
 *
 * SUPERJOY_* is the canonical prefix. HEYJADA_* is supported as a deprecated
 * fallback (a warning is emitted once per variable), and PIPALI_* remains as
 * a silent legacy fallback for packaged builds.
 */

const warnedVars = new Set<string>();

/**
 * Resolve a branded environment variable by suffix (e.g. "HOST" checks
 * SUPERJOY_HOST, then HEYJADA_HOST, then PIPALI_HOST).
 */
export function getBrandedEnv(name: string): string | undefined {
    const superjoy = process.env[`SUPERJOY_${name}`];
    if (superjoy !== undefined && superjoy !== '') {
        return superjoy;
    }

    const heyjada = process.env[`HEYJADA_${name}`];
    if (heyjada !== undefined && heyjada !== '') {
        if (!warnedVars.has(name)) {
            warnedVars.add(name);
            // console to avoid a circular dependency with the logger (which resolves log paths via env)
            console.warn(`⚠️  HEYJADA_${name} is deprecated. Use SUPERJOY_${name} instead.`);
        }
        return heyjada;
    }

    const pipali = process.env[`PIPALI_${name}`];
    if (pipali !== undefined && pipali !== '') {
        return pipali;
    }

    return undefined;
}
