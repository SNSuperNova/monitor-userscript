import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class FakeStorage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.has(String(key)) ? this.data.get(String(key)) : null; }
  setItem(key, value) { this.data.set(String(key), String(value)); }
  removeItem(key) { this.data.delete(String(key)); }
  clear() { this.data.clear(); }
}

class FakeXHR {
  constructor() {
    this.listeners = new Map();
    this.status = 200;
    this.responseType = '';
    this.responseText = '{"xhr":true}';
  }
  open(method, url) { this.opened = { method, url }; }
  send(body) { this.sentBody = body; this.listeners.get('loadend')?.(); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  getResponseHeader(name) { return name === 'content-type' ? 'application/json' : null; }
}

const intervalCallbacks = [];
const localStorage = new FakeStorage();
const sessionStorage = new FakeStorage();
const windowListeners = new Map();
const responseBytes = new TextEncoder().encode('{"fetch":true}');
let fetchCalls = 0;
let cloneCalls = 0;
let holdFetchBodiesOpen = false;

const window = {
  localStorage,
  sessionStorage,
  XMLHttpRequest: FakeXHR,
  Storage: FakeStorage,
  performance,
  TextDecoder,
  URL,
  Blob,
  Symbol,
  fetch: async () => {
    fetchCalls += 1;
    return {
      status: 200,
      ok: true,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      clone: () => ({
        body: new ReadableStream({
          start(controller) {
            cloneCalls += 1;
            if (!holdFetchBodiesOpen) {
              controller.enqueue(responseBytes);
              controller.close();
            }
          },
        }),
      }),
    };
  },
  addEventListener(name, callback) { windowListeners.set(name, callback); },
};
window.window = window;

const context = vm.createContext({
  window,
  XMLHttpRequest: FakeXHR,
  Storage: FakeStorage,
  performance,
  TextDecoder,
  URL,
  Blob,
  Symbol,
  Reflect,
  Object,
  WeakMap,
  Map,
  Set,
  Date,
  JSON,
  Math,
  Number,
  String,
  Boolean,
  Array,
  RegExp,
  Error,
  document: { documentElement: null },
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval(callback) { intervalCallbacks.push(callback); return intervalCallbacks.length; },
  setTimeout,
  requestAnimationFrame(callback) { callback(); },
  console,
});

const source = fs.readFileSync(new URL('../runtime-monitor.user.js', import.meta.url), 'utf8');
vm.runInContext(source, context, { filename: 'runtime-monitor.user.js' });

assert.notEqual(window.fetch.name, '', 'fetch should be wrapped');
const response = await window.fetch('/api/smoke');
assert.equal(response.status, 200);
assert.equal(fetchCalls, 1, 'wrapped fetch should call the native implementation once');
await new Promise((resolve) => setImmediate(resolve));

cloneCalls = 0;
holdFetchBodiesOpen = true;
await Promise.all(Array.from({ length: 9 }, (_, index) => window.fetch(`/api/concurrent/${index}`)));
assert.equal(cloneCalls, 8, 'concurrent response cloning should be bounded');

const xhr = new FakeXHR();
xhr.open('POST', '/api/xhr');
xhr.send('{"hello":"world"}');
assert.deepEqual(xhr.opened, { method: 'POST', url: '/api/xhr' });

localStorage.setItem('token', 'redacted-test-value');
assert.equal(localStorage.getItem('token'), 'redacted-test-value');
localStorage.removeItem('token');
assert.equal(localStorage.getItem('token'), null);

window.newRuntimeValue = { count: 1 };
assert.equal(intervalCallbacks.length, 1, 'one bounded scanner should be installed');
intervalCallbacks[0]();

console.log('runtime-monitor smoke test passed');
