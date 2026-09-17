// Deterministic substitutes for extension-wide locks and Chrome alarm delivery.
export function installScheduling(chrome) {
  let queue = Promise.resolve();
  globalThis.navigator = {locks:{request:(_name, run) => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }}};
  const alarms = new Map();
  let listener;
  chrome.alarms = {
    create:async(name, info) => {alarms.set(name, {name, ...info});},
    clear:async name => alarms.delete(name),
    onAlarm:{addListener:fn => {listener = fn;}}
  };
  return {alarms, fire:async name => listener?.(alarms.get(name) || {name})};
}
