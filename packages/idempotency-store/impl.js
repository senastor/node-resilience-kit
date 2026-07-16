class IdempotencyStore {
  constructor(opts) { this.store=new Map(); this.ttl=(opts&&opts.ttl)||86400000; this.cleanupMs=(opts&&opts.cleanupMs)||300000; this.timer=setInterval(()=>this.cleanup(),this.cleanupMs); }
  check(key) { if(this.store.has(key)){const e=this.store.get(key);if(Date.now()-e.ts<this.ttl)return e.result;this.store.delete(key);} return null; }
  set(key,result) { this.store.set(key,{ts:Date.now(),result}); }
  cleanup() { const now=Date.now(); for(const[k,v]of this.store){if(now-v.ts>=this.ttl)this.store.delete(k);} }
  stats() { return {size:this.store.size}; }
  destroy() { clearInterval(this.timer); this.store.clear(); }
}
module.exports = IdempotencyStore;
if (require.main===module){const s=new IdempotencyStore({ttl:1000});s.set("a",{ok:true});console.log("check:",JSON.stringify(s.check("a")));console.log("PASS:",JSON.stringify(s.stats()));s.destroy();}