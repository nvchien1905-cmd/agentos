'use strict';
// Quản lý các BOT TELEGRAM phụ (agent) từ trang Cài đặt (chạy bằng root nên gọi THẲNG agentctl, không cần tệp yêu cầu).
// Sổ agent dùng chung với /daily trên Telegram (data/agents.json), nên hai nơi luôn khớp nhau.
const crypto = require('crypto');
const { createAgentCtl, SETTINGS, LIMITS, validateSettings } = require('../../orchestrator/src/agentctl');
const { createAgents } = require('../../orchestrator/src/agents');

// Mô tả các mục quyền hạn để trang vẽ nút/ô nhập (không chứa giá trị bí mật)
function spec() {
  const out = {};
  for (const [k, d] of Object.entries(SETTINGS)) out[k] = { kind: d.kind, label: d.label, values: d.values || null, lo: d.lo === undefined ? null : d.lo, hi: d.hi === undefined ? null : d.hi, def: d.def === undefined ? null : d.def, options: d.options || null };
  return out;
}

function createBots(o) {
  o = o || {};
  const ctl = o.ctl || createAgentCtl({});
  const make = () => createAgents({
    file: o.file, mainToken: o.mainToken ? o.mainToken() : '', owners: () => (o.owners ? o.owners() : []), getMe: o.getMe, show: o.show, log: o.log,
    call: (req) => ctl.handle(Object.assign({ rid: crypto.randomBytes(8).toString('hex') }, req)),
  });
  const tidy = () => { try { if (o.afterSave) o.afterSave(o.file); } catch (e) { /* bỏ qua */ } };

  async function list() {
    const ag = make();
    const items = await ag.list();
    return {
      agents: items.map((a) => ({
        id: a.id, name: a.name, bot: a.bot || null, owners: a.owners || [], ramMb: a.ramMb, cpuPct: a.cpuPct, settings: a.settings || {}, sudo: a.sudo === true, createdAt: a.createdAt,
        status: a.status,
      })),
      spec: spec(), limits: { ramMb: LIMITS.ramMb, cpuPct: LIMITS.cpuPct },
    };
  }
  async function add(b) {
    const ag = make();
    const r = await ag.add({ token: b.token, name: b.name, ramMb: b.ramMb ? Number(b.ramMb) : undefined, cpuPct: b.cpuPct ? Number(b.cpuPct) : undefined, ownerIds: Array.isArray(b.owners) ? b.owners : undefined, settings: b.settings && Object.keys(b.settings).length ? validateSettings(b.settings) : undefined });
    tidy(); return { agent: r.agent, warn: r.warn };
  }
  async function control(b) {
    const verb = String(b.verb || ''); if (!['start', 'stop', 'restart'].includes(verb)) throw new Error('Việc không hợp lệ.');
    const r = await make().control(String(b.id || ''), verb); return { msg: r.msg };
  }
  async function update(b) {
    const f = {};
    if (b.name !== undefined) f.name = String(b.name);
    if (b.owners !== undefined) f.owners = (Array.isArray(b.owners) ? b.owners : String(b.owners).split(/[\s,;]+/)).filter(Boolean).map(String);
    if (b.ramMb !== undefined) f.ramMb = Number(b.ramMb);
    if (b.cpuPct !== undefined) f.cpuPct = Number(b.cpuPct);
    if (b.settings !== undefined) f.settings = validateSettings(b.settings);
    if (b.sudo !== undefined) { if (typeof b.sudo !== 'boolean') throw new Error('sudo phải là true/false'); f.sudo = b.sudo; }
    const r = await make().update(String(b.id || ''), f); tidy(); return { agent: r.agent };
  }
  async function logs(b) { const r = await make().logs(String(b.id || ''), Number(b.lines) || 60); return { text: r.text }; }
  async function remove(b) {
    if (b.confirm !== true) throw new Error('Cần xác nhận');
    const r = await make().remove(String(b.id || ''), b.purge === true); tidy(); return { kept: r.kept };
  }
  // Tài nguyên chung (RAM/CPU) cho mọi bot: xem trạng thái / bật tắt / đổi phần RAM để lại cho hệ thống
  async function pool() { return ctl.poolStatus ? ctl.poolStatus() : { enabled: false, unsupported: true }; }
  async function setPool(b) {
    const req = { rid: crypto.randomBytes(8).toString('hex'), action: 'pool' };
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new Error('enabled phải là true/false'); req.enabled = b.enabled; }
    if (b.reserveMb !== undefined) req.reserveMb = Number(b.reserveMb);
    const r = await ctl.handle(req); if (!r.ok) throw new Error(r.msg);
    return Object.assign({ msg: r.msg }, await pool());
  }
  return { list, add, control, update, logs, remove, spec, pool, setPool };
}

module.exports = { createBots, spec };
