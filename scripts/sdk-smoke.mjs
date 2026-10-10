import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'pi-memory-sdk-'));
for (const key of Object.keys(process.env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) delete process.env[key];
process.env.HOME = join(fixture, 'home');
process.env.PI_CODING_AGENT_DIR = join(fixture, 'agent');
process.env.PI_MEMORY_DIR = join(fixture, 'global');
process.env.PI_OFFLINE = '1';
const sdk = await import(process.env.PI_MEMORY_SDK_MODULE || '@earendil-works/pi-coding-agent');
const root = join(fixture, 'repo');
mkdirSync(root); execFileSync('git', ['init', '-q', root]);
mkdirSync(join(root, '.pi')); writeFileSync(join(root, '.pi', 'settings.json'), '{}');
mkdirSync(process.env.PI_MEMORY_DIR, { recursive: true });
writeFileSync(join(process.env.PI_MEMORY_DIR, 'MEMORY.md'), '- SDK_GLOBAL_FACT\n');
writeFileSync(join(process.env.PI_MEMORY_DIR, 'config.json'), JSON.stringify({ pageTableInjection: false, traceEnabled: false }));
const project = join(root, '.git', 'pi-memory'); mkdirSync(project); writeFileSync(join(project, 'MEMORY.md'), '- SDK_PROJECT_FACT\n');
const model = { id: 'memory-smoke', name: 'No inference', provider: 'openai', api: 'openai-responses', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 };
const evidence = [];
try {
  for (const trusted of [true, false]) {
    const settings = sdk.SettingsManager.inMemory({ defaultProjectTrust: trusted ? 'always' : 'never', compaction: { enabled: false } }, { projectTrusted: trusted });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [join(packageRoot, 'extensions/index.ts')] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader,
      settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(root), model });
    try {
      const errors = [];
      await session.bindExtensions({ onError: error => errors.push(error) });
      assert(session.getActiveToolNames().includes('memory_search'));
      const result = await session.extensionRunner.emitBeforeAgentStart('fixture prompt', undefined, { cwd: root });
      const block = result.systemPromptOptions.appendSystemPrompt;
      assert(block.includes('SDK_GLOBAL_FACT'));
      assert.equal(block.includes('SDK_PROJECT_FACT'), trusted);
      assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined, 'keep structured prompt sections');
      if (trusted) {
        await session.prompt('/memory remember project SDK_STAGED_FACT');
        await session.prompt('/memory flush');
        assert(readFileSync(join(project, 'MEMORY.md'), 'utf8').includes('SDK_STAGED_FACT'));
      } else {
        const before = readFileSync(join(project, 'MEMORY.md'), 'utf8');
        await session.prompt('/memory remember project FORBIDDEN_UNTRUSTED_FACT');
        await session.prompt('/memory flush');
        assert.equal(readFileSync(join(project, 'MEMORY.md'), 'utf8'), before);
      }
      const searchTool = session.agent.state.tools.find(tool => tool.name === 'memory_search');
      writeFileSync(join(process.env.PI_MEMORY_DIR, 'config.json'), JSON.stringify({ enabled: false }));
      await assert.rejects(searchTool.execute('disabled-smoke', { query: 'fixture' }, undefined, undefined), /Persistent memory is disabled/);
      writeFileSync(join(process.env.PI_MEMORY_DIR, 'config.json'), JSON.stringify({ pageTableInjection: false, traceEnabled: false }));
      assert.deepEqual(errors, []);
      evidence.push({ trusted, injection: 'passed', searchRegistered: true, searchDisabledVerified: true, structuredPrompt: true });
    } finally { session.dispose(); }
  }
  console.log(JSON.stringify({ sdk: process.env.PI_MEMORY_SDK_MODULE || 'public Pi 1.1.0', evidence, noProviderCalls: true }));
} finally { rmSync(fixture, { recursive: true, force: true }); }
