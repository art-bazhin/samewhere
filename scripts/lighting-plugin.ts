import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import type { Plugin, ResolvedConfig } from 'vite';
import type { LightingBakeQuality } from '../src/panel-light-bake';

const MODULE = 'virtual:samewhere-lighting', ID = `\0${MODULE}`;
const execute = promisify(execFile);

/** Follow the bake's local imports, so new algorithm dependencies invalidate it too. */
export async function lightingRevision(root: string, quality: LightingBakeQuality = 'full', entry = 'scripts/bake-lighting.ts') {
  const sources = new Map<string, string>();
  async function visit(path: string) {
    if (sources.has(path)) return;
    const source = await readFile(path, 'utf8'); sources.set(path, source);
    for (const imported of ts.preProcessFile(source, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const module = ts.resolveModuleName(imported.fileName, path, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule;
      if (!module) throw new Error(`Unresolved lighting dependency: ${imported.fileName} in ${path}`);
      await visit(module.resolvedFileName);
    }
  }
  await visit(resolve(root, entry));
  for (const file of ['scripts/lighting-plugin.ts', 'package.json', 'package-lock.json']) {
    const path = resolve(root, file); sources.set(path, await readFile(path, 'utf8'));
  }
  const hash = createHash('sha256').update(process.version).update('\0').update(quality);
  for (const [path, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) hash.update(relative(root, path)).update('\0').update(source).update('\0');
  return { revision: hash.digest('hex'), files: new Set(sources.keys()) };
}

/** Build/dev preparation and compressed static delivery share the same immutable asset. */
export function lightingPlugin(): Plugin {
  let config: ResolvedConfig, files = new Set<string>();
  let current: { revision: string; path: string } | undefined, pending: Promise<NonNullable<typeof current>> | undefined;
  const cache = () => resolve(config.root, 'node_modules/.cache/samewhere-lighting');
  const quality = (): LightingBakeQuality => config.command === 'build' ? 'full' : 'draft';
  async function generate(): Promise<NonNullable<typeof current>> {
    const input = await lightingRevision(config.root, quality()); files = input.files;
    if (current?.revision === input.revision) return current;
    const path = join(cache(), `${input.revision}.bin`);
    try { await Promise.all(['', '.br', '.gz'].map(suffix => access(path + suffix))); }
    catch {
      config.logger.info(`[lighting] Preparing ${quality()} lighting…`);
      const result = await execute(process.execPath, ['--import', 'tsx', resolve(config.root, 'scripts/bake-lighting.ts'), path, input.revision, quality()], { cwd: config.root });
      config.logger.info(result.stdout.trim());
    }
    // An edit during a running bake must never publish data for the wrong sources.
    if ((await lightingRevision(config.root, quality())).revision !== input.revision) return generate();
    return current = { revision: input.revision, path };
  }
  const ensure = () => pending ??= generate().finally(() => { pending = undefined; });
  const serve = (directory: string, cached = false) => async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const match = request.url?.split('?')[0].match(/\/assets\/lighting-([a-f0-9]{64})\.bin$/);
    if (!match) { next(); return; }
    try {
      const accepts = (request.headers['accept-encoding'] ?? '').split(',').filter(value => !/;\s*q=0(?:\.0*)?\s*$/.test(value)).map(value => value.split(';')[0].trim());
      const encoding = accepts.includes('br') ? 'br' : accepts.includes('gzip') ? 'gzip' : '';
      const path = cached ? join(directory, `${match[1]}.bin`) : join(directory, 'assets', `lighting-${match[1]}.bin`);
      const bytes = await readFile(path + (encoding === 'br' ? '.br' : encoding ? '.gz' : ''));
      response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Vary', 'Accept-Encoding');
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); response.setHeader('Content-Length', bytes.length);
      if (encoding) response.setHeader('Content-Encoding', encoding);
      response.end(bytes);
    } catch { response.statusCode = 404; response.end('Lighting data not found'); }
  };
  return {
    name: 'samewhere-lighting',
    configResolved(value) { config = value; },
    async buildStart() { await ensure(); for (const path of files) this.addWatchFile(path); },
    resolveId(id) { if (id === MODULE) return ID; },
    async load(id) {
      if (id !== ID) return;
      const asset = await ensure(), name = `assets/lighting-${asset.revision}.bin`;
      let url = JSON.stringify(`${config.base}${name}`);
      if (config.command === 'build') {
        const reference = this.emitFile({ type: 'asset', fileName: name, source: await readFile(asset.path) });
        for (const suffix of ['.br', '.gz']) this.emitFile({ type: 'asset', fileName: name + suffix, source: await readFile(asset.path + suffix) });
        url = `import.meta.ROLLUP_FILE_URL_${reference}`;
      }
      return `export default ${url}; export const revision = ${JSON.stringify(asset.revision)};`;
    },
    configureServer(server) { server.middlewares.use(serve(cache(), true)); },
    configurePreviewServer(server) { server.middlewares.use(serve(resolve(config.root, config.build.outDir))); },
    async hotUpdate(context) {
      if (this.environment.name !== 'client') return;
      const dependency = files.has(context.file);
      // A newly created module can resolve an import that previously failed.
      if (!dependency && !(context.type === 'create' && context.file.startsWith(config.root + '/') && /\.tsx?$/.test(context.file))) return;
      const previous = current?.revision, asset = await ensure();
      for (const path of files) context.server.watcher.add(path);
      if (!dependency && previous === asset.revision) return;
      this.environment.moduleGraph.invalidateAll(); this.environment.hot.send({ type: 'full-reload' }); return [];
    },
  };
}
