import { AppStore } from './store.js';
import { SystemProvider } from './providers/system.js';
import { LogWatcher } from './providers/logs.js';
import { Tui } from './ui.js';

const store = new AppStore();
const systemProvider = new SystemProvider();
const logWatcher = new LogWatcher('/opt/llama/logs/stderr.log');
const ui = new Tui(store);

// Metric Polling Loop
setInterval(async () => {
    const ram = await systemProvider.getRam();
    const gpu = await systemProvider.getGpu();
    store.updateSystem({ ramUsed: ram.used, ramTotal: ram.total, gpu });
}, 1000);

logWatcher.on('line', (line) => store.addLog(line));
logWatcher.start();

ui.render(store.state);
