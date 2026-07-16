class RetryQueue {
  constructor(opts) {
    this.queue = []; this.processing = false;
    this.maxRetries = (opts&&opts.maxRetries)||3;
    this.backoffBase = (opts&&opts.backoffBase)||1000;
    this.onProcess = (opts&&opts.onProcess)||(()=>Promise.resolve());
  }
  async enqueue(item) { this.queue.push({item,retries:0}); if(!this.processing) this.process(); }
  async process() { this.processing=true; while(this.queue.length){const t=this.queue[0];try{await this.onProcess(t.item);this.queue.shift();}catch(e){if(++t.retries>=this.maxRetries){this.queue.shift();}else{await new Promise(r=>setTimeout(r,this.backoffBase*Math.pow(2,t.retries-1)));}}} this.processing=false; }
  stats() { return {length:this.queue.length, processing:this.processing}; }
}
module.exports = RetryQueue;
if (require.main===module){const q=new RetryQueue({onProcess:async i=>console.log("done:",i)});console.log("PASS:",JSON.stringify(q.stats()));}