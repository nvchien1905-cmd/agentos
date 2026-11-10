'use strict';
// BOT QUẢN LÝ các agent (bot Telegram phụ). Mỗi agent chạy tách hẳn: tài khoản hệ thống riêng, dịch vụ riêng, giới hạn RAM/CPU riêng
// (xem agentctl.js). Mô-đun này chạy trong bộ điều phối chính (người dùng `agentos`, không phải root): nó chỉ thả tệp yêu cầu
// cho agentos-agentctl và đọc trạng thái bằng `systemctl show`. Token bot phụ KHÔNG lưu ở đây (chỉ root giữ trong /etc/agentos/agents).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { TOKEN_RE, ID_RE, LIMITS, unitName } = require('./agentctl');

const CTL = '/var/lib/agentos-agentctl';
const MAX_AGENTS = 12;

function realSystemctlShow(id) {
  return new Promise((res) => execFile('systemctl', ['show', unitName(id) + '.service', '-p', 'ActiveState,SubState,MemoryCurrent,NRestarts,ActiveEnterTimestamp,LoadState'], { timeout: 8000 }, (e, so) => {
    const o = {}; for (const l of String(so || '').split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
    res(o);
  }));
}

async function realGetMe(token) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/getMe', { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || ('Telegram trả lỗi ' + r.status));
  return j.result;
}

function createAgents(o) {
  o = o || {};
  const file = o.file;                                    // data/agents.json
  const reqDir = o.reqDir || CTL + '/req', resDir = o.resDir || CTL + '/res';
  const show = o.show || realSystemctlShow;
  const getMe = o.getMe || realGetMe;
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs || 90000;
  const mainToken = o.mainToken || '';
  const owners = () => (o.owners ? o.owners() : []);
  const log = o.log || (() => {});

  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.agents) ? j : { agents: [] }; } catch (e) { return { agents: [] }; } };
  const save = (st) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(t, file); };

  // Thả yêu cầu cho root và chờ kết quả
  async function call(req) {
    const rid = crypto.randomBytes(8).toString('hex');
    const body = JSON.stringify(Object.assign({}, req, { rid }));
    const f = path.join(reqDir, rid + '.json');
    try { fs.writeFileSync(f, body, { mode: 0o640, flag: 'wx' }); }
    catch (e) { throw new Error('Chưa gửi được yêu cầu cho hệ thống (' + (e.code || e.message) + '). Máy cần cập nhật lên bản có agent rồi khởi động lại, hoặc chạy: sudo agentos-agentctl init'); }
    const out = path.join(resDir, rid + '.json'), t0 = now();
    while (now() - t0 < waitMs) {
      try { const j = JSON.parse(fs.readFileSync(out, 'utf8')); try { fs.rmSync(out, { force: true }); } catch (e) { /* res/ chỉ đọc với agentos: bỏ qua, root tự dọn */ } return j; } catch (e) { /* chưa có */ }
      await sleep(o.pollMs || 500);
    }
    try { fs.rmSync(f, { force: true }); } catch (e) { /* bỏ qua */ }
    throw new Error('Hệ thống không trả lời sau ' + Math.round(waitMs / 1000) + ' giây (agentos-agentctl.path có đang chạy không?).');
  }

  function get(id) { return load().agents.find((a) => a.id === id) || null; }
  function resolve(ref) {                                  // nhận "a1", "1" hoặc tên
    const st = load().agents, r = String(ref || '').trim().toLowerCase();
    if (!r) return null;
    return st.find((a) => a.id === r) || st.find((a) => a.id === 'a' + r) || st.find((a) => String(a.name).toLowerCase() === r) || st.find((a) => a.bot && a.bot.username && a.bot.username.toLowerCase() === r.replace(/^@/, '')) || null;
  }
  const nextId = (st) => { const used = new Set(st.map((a) => a.id)); for (let i = 1; i < 1000; i++) if (!used.has('a' + i)) return 'a' + i; throw new Error('Hết mã agent'); };

  async function add({ token, name, ramMb, cpuPct, ownerIds }) {
    token = String(token || '').trim();
    if (!TOKEN_RE.test(token)) throw new Error('Token bot không đúng dạng (dạng 123456789:AAAA...). Lấy ở @BotFather.');
    if (token === mainToken) throw new Error('Đó là token của bot quản lý. Mỗi agent phải có bot RIÊNG: tạo bot mới ở @BotFather (/newbot).');
    const st = load();
    if (st.agents.length >= MAX_AGENTS) throw new Error('Tối đa ' + MAX_AGENTS + ' agent trên một máy.');
    let me; try { me = await getMe(token); } catch (e) { throw new Error('Telegram không nhận token này: ' + e.message); }
    if (st.agents.some((a) => a.bot && a.bot.id === me.id)) throw new Error('Bot @' + me.username + ' đã là agent ' + st.agents.find((a) => a.bot.id === me.id).id + '.');
    const ow = (ownerIds && ownerIds.length ? ownerIds : owners()).map(String);
    if (!ow.length) throw new Error('Chưa có ID chủ máy để gán cho agent.');
    const id = nextId(st.agents);
    const nm = String(name || '').trim() || me.first_name || ('Agent ' + id);
    const r = await call({ action: 'create', id, token, name: nm, owners: ow, ramMb: ramMb || LIMITS.ramMb[2], cpuPct: cpuPct || LIMITS.cpuPct[2] });
    if (!r.ok) throw new Error(r.msg);
    st.agents.push({ id, name: nm.slice(0, 40), bot: { id: me.id, username: me.username }, owners: ow, ramMb: ramMb || LIMITS.ramMb[2], cpuPct: cpuPct || LIMITS.cpuPct[2], createdAt: now() });
    save(st);
    log('agent ' + id + ' (@' + me.username + ') đã tạo');
    return { agent: get(id), warn: r.warn || '' };
  }

  async function control(ref, verb) {
    const a = resolve(ref); if (!a) throw new Error('Không có agent "' + ref + '".');
    const r = await call({ action: verb, id: a.id });
    if (!r.ok) throw new Error(r.msg);
    return { agent: a, msg: r.msg };
  }

  async function remove(ref, purge) {
    const a = resolve(ref); if (!a) throw new Error('Không có agent "' + ref + '".');
    const r = await call({ action: 'remove', id: a.id, purge: !!purge });
    if (!r.ok) throw new Error(r.msg);
    const st = load(); st.agents = st.agents.filter((x) => x.id !== a.id); save(st);
    log('agent ' + a.id + ' đã xóa');
    return { agent: a, kept: r.kept || '' };
  }

  async function update(ref, fields) {
    const a = resolve(ref); if (!a) throw new Error('Không có agent "' + ref + '".');
    const req = { action: 'update', id: a.id };
    if (fields.name !== undefined) req.name = fields.name;
    if (fields.owners !== undefined) req.owners = fields.owners.map(String);
    if (fields.ramMb !== undefined) req.ramMb = fields.ramMb;
    if (fields.cpuPct !== undefined) req.cpuPct = fields.cpuPct;
    const r = await call(req);
    if (!r.ok) throw new Error(r.msg);
    const st = load(), x = st.agents.find((y) => y.id === a.id);
    if (req.name !== undefined) x.name = String(req.name).slice(0, 40);
    if (req.owners !== undefined) x.owners = req.owners;
    if (req.ramMb !== undefined) x.ramMb = req.ramMb;
    if (req.cpuPct !== undefined) x.cpuPct = req.cpuPct;
    save(st);
    return { agent: x };
  }

  async function logs(ref, lines) {
    const a = resolve(ref); if (!a) throw new Error('Không có agent "' + ref + '".');
    const r = await call({ action: 'logs', id: a.id, lines: lines || 40 });
    if (!r.ok) throw new Error(r.msg);
    return { agent: a, text: r.text || '' };
  }

  async function status(a) {
    const s = await show(a.id).catch(() => ({}));
    const active = s.ActiveState === 'active';
    return { active, state: s.ActiveState || 'unknown', sub: s.SubState || '', memMb: Number(s.MemoryCurrent) > 0 && Number(s.MemoryCurrent) < 1e15 ? Math.round(Number(s.MemoryCurrent) / 1048576) : null, restarts: Number(s.NRestarts) || 0, since: s.ActiveEnterTimestamp || '', missing: s.LoadState === 'not-found' };
  }

  async function list() {
    const out = [];
    for (const a of load().agents) out.push(Object.assign({}, a, { status: await status(a) }));
    return out;
  }

  return { add, remove, control, update, logs, list, get, resolve, status, call };
}

module.exports = { createAgents, MAX_AGENTS, ID_RE };
