import { expect, test } from 'bun:test';
import type { WorkerTabSession } from '@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor';
import { startVideo, nextVideo, stopVideo } from '../src/commands/browser-video';

test('a waiting video pull returns the arriving packet without waiting for the idle timeout', async () => {
  let binding!: (event: {name: string; payload: string}) => void;
  let sourceId = '';
  const helper = {
    async send(method: string, params?: {expression?: string}) {
      if (method === 'Performance.getMetrics') return {metrics: [{name:'Timestamp',value:performance.now()/1000}]};
      if (method !== 'Runtime.evaluate') return {};
      const expression = params?.expression ?? '';
      if (expression.startsWith('addEncoder')) {
        sourceId = JSON.parse(expression.slice(expression.indexOf(',')+1,-1));
        return {result:{value:{codec:'vp8'}}};
      }
      return {result:{value:true}};
    },
    on(_event: string, listener: typeof binding) {binding=listener;},
    async detach() {},
  };
  const target = {_targetId:'page',async createCDPSession(){return {async send(){return {cssVisualViewport:{clientWidth:640,clientHeight:480}}},async detach(){}}}};
  const helperTarget = {async createCDPSession(){return helper}};
  // Only CDP discovery and the video command path's browser fields are used.
  const tab = {browser:{browser:{targets:()=>[target],target:()=>({async createCDPSession(){return {async send(){return {targetId:'helper'}},async detach(){}}}}),async waitForTarget(){return helperTarget}}}} as unknown as WorkerTabSession;
  const opened = await startVideo(tab,'page','owner',()=>true);
  const originalSetTimeout = globalThis.setTimeout;
  const waiting = Promise.withResolvers<void>();
  let idleTimer: NodeJS.Timeout | undefined;
  // Hold just the idle deadline. Packet arrival, not an elapsed clock, must complete the pull.
  globalThis.setTimeout = ((callback: (...args: unknown[])=>void, delay?: number, ...args: unknown[]) => {
    if (delay === 100) {
      idleTimer = originalSetTimeout(()=>callback(...args),60_000);
      idleTimer.unref();
      waiting.resolve();
      return idleTimer;
    }
    return originalSetTimeout(callback,delay,...args);
  }) as typeof setTimeout;
  try {
    const pull = nextVideo(opened.streamId,'page','owner');
    await waiting.promise;
    binding({name:'nativeVideoPacket',payload:JSON.stringify({streamId:sourceId,sequence:1,captureGeneration:1,timestampUs:1000000,type:'key',width:640,height:480,dataBase64:'AQID'})});
    const result = await pull;
    expect(result.packets).toEqual([expect.objectContaining({type:'key',timestamp:1000000,width:640,height:480,data:'AQID'})]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    clearTimeout(idleTimer);
    stopVideo(opened.streamId,'page','owner');
  }
});
