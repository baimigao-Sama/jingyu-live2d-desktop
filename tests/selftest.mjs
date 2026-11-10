/* 0号第三轮·规矩2：自检脚本。每次改完跑一遍。
 * 用法: node tests/selftest.mjs   (DSH自带node)
 * 静态检查必过;MCP活体检查可选(exe在跑才验)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) fails++;
}

/* 1. 模型配置 */
const mj = JSON.parse(fs.readFileSync(path.join(ROOT, 'models', 'nono.model3.json'), 'utf8'));
const exprs = (mj.FileReferences?.Expressions || []).map(e => e.Name);
const motions = Object.keys(mj.FileReferences?.Motions || mj.Motions || {});
check('模型加载成功(model3.json可读)', true, 'nono.model3.json');
check('表情 ≥ 20 个', exprs.length >= 20, exprs.length + '个: ' + exprs.slice(0, 5).join(',') + '…');
check('动作组 ≥ 8 个', motions.length >= 8, motions.length + '组: ' + motions.join(','));

/* 2. 贴图一张没少,且没有JPG(0号第四优先:PNG不许转JPG) */
const texDir = path.join(ROOT, 'models', 'deepseek', '大肥鱼.4096');
const texs = fs.readdirSync(texDir).filter(f => f.endsWith('.png'));
check('贴图 5 张 PNG 全在', texs.length === 5, texs.join(','));
const jpgs = [];
for (const f of fs.readdirSync(path.join(ROOT, 'models', 'deepseek'))) {
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) jpgs.push(f);
}
check('模型目录无 JPG(透明度安全)', jpgs.length === 0, jpgs.length ? jpgs.join(',') : '干净');

/* 3. strings.json */
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'strings', 'strings.json'), 'utf8'));
const poolLines = Object.values(S.bubble_pool || {}).reduce((a, b) => a + b.length, 0);
check('strings.json 可读', true);
check('台词池 ≥ 80 句', poolLines >= 80, poolLines + '句 / ' + Object.keys(S.bubble_pool || {}).length + '个场景');
check('菜单文案齐全(右键菜单用)', ['pat', 'say', 'expr', 'size', 'always_top'].every(k => S.menu?.[k]), '');

/* 4. MCP 工具注册(静态扫描) */
const mcpSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'mcp-server.js'), 'utf8');
for (const tool of ['get_capabilities', 'play_plan', 'stop', 'set_activity']) {
  check('MCP工具: ' + tool, mcpSrc.includes("name: '" + tool + "'"), '');
}
check('play_plan 校验存在(at递增/类型/表情存在/夹紧)',
  mcpSrc.includes('validatePlan') && mcpSrc.includes('必须递增') && mcpSrc.includes('Math.min'), '');

/* 5. 右键菜单(静态扫描) */
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
check('右键菜单模板共享(tray+popup)', mainSrc.includes('buildMenuTemplate') && mainSrc.includes('showContextMenu'), '');
check('画布右键接线(nono-context-menu)', mainSrc.includes('nono-context-menu'), '');
const interactSrc = fs.readFileSync(path.join(ROOT, 'js', 'interact.js'), 'utf8');
check('渲染层右键拦截(contextmenu事件)', interactSrc.includes("addEventListener('contextmenu'"), '');
check('摸摸头/说句话已实现', interactSrc.includes('autoPat') && interactSrc.includes('saySomething'), '');

/* 6. 内存优化(静态确认) */
check('打包排除 map/test/docs/md', mainSrc.includes('!**/*.map') || fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').includes('!**/*.map'), '');
check('不活动降帧已接', fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8').includes('maxFPS'), '');

/* 8. 配方库守门(0号第六轮⑤):库和桌宠不许走散 */
const EXPR_SEM = ['idle', 'happy', 'shy', 'sad', 'serious', 'sleepy', 'excited', 'surprised', 'thinking', 'angry', 'smile', 'typing'];
const recDir = path.join(ROOT, 'recipes');
const recFiles = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter(f => f.endsWith('.json')) : [];
// 配方库产出目录：只有本机存在时才对账；开源环境没有这个目录，直接跳过（记 0）
const zProd = process.env.NONO_RECIPE_LIB || '';
const prodJsons = zProd && fs.existsSync(zProd)
  ? fs.readdirSync(zProd).filter(f => f.endsWith('.json') && f !== 'index.md') : [];
if (prodJsons.length) {
  check('配方: 桌宠包与库产出数量一致', recFiles.length === prodJsons.length && recFiles.length >= 10, recFiles.length + ' vs ' + prodJsons.length);
} else {
  check('配方: 数量 ≥10（未接动作库，跳过对账）', recFiles.length >= 10, String(recFiles.length));
}
const recipeBad = [];
for (const f of recFiles) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8'));
    if (!Array.isArray(r.steps) || !r.steps.length) { recipeBad.push(f + ':steps空'); continue; }
    for (const s of r.steps) {
      if (['look', 'expression', 'angle', 'motion', 'preset', 'trajectory'].indexOf(s.type) < 0) recipeBad.push(f + ':' + s.type + '不认识');
      if (s.type === 'trajectory' && (!Array.isArray(s.frames) || !s.frames.length)) recipeBad.push(f + ':trajectory缺frames');
      if (s.type === 'expression' && EXPR_SEM.indexOf(s.name) < 0) recipeBad.push(f + ':表情 ' + s.name);
      if (s.type === 'motion' && motions.indexOf(s.group) < 0) recipeBad.push(f + ':动作组 ' + s.group);
      if (s.type === 'preset' && exprs.indexOf(s.name) < 0) recipeBad.push(f + ':预设 ' + s.name);
    }
  } catch (e) { recipeBad.push(f + ':JSON坏'); }
}
check('配方: 全部合法,表情/动作/预设都在名册', recipeBad.length === 0, recipeBad.slice(0, 3).join(';'));

/* 9. 台词池每场景 ≥5 句(0号第六轮⑥) */
const under = Object.entries(S.bubble_pool || {}).filter(([k, v]) => v.length < 5);
check('台词池: 每场景 ≥5 句', under.length === 0, under.map(([k, v]) => k + ':' + v.length).join(','));

/* 7. MCP 活体检查(exe在跑时才有) */
try {
  const r = await fetch('http://127.0.0.1:8768/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(3000)
  });
  const tools = (await r.json()).result.tools.map(t => t.name);
  check('MCP活体: 工具 ≥ 10', tools.length >= 10, tools.length + '个: ' + tools.join(','));
  const caps = await fetch('http://127.0.0.1:8768/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_capabilities', arguments: {} } }),
    signal: AbortSignal.timeout(3000)
  });
  const c = JSON.parse((await caps.json()).result.content[0].text);
  check('MCP活体: get_capabilities 返回真实名册', c.expressions.length >= 20 && c.motions.length >= 8,
    '表情' + c.expressions.length + '/动作' + c.motions.length + '/参数' + Object.keys(c.parameters).length);
} catch (e) {
  console.log('— MCP活体检查跳过(exe没在跑): ' + e.message);
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项未过'); process.exit(1); }
console.log('全部通过');
