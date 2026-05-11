import fs from 'fs';
import EventEmitter from 'events';

export class LogWatcher extends EventEmitter {
    constructor(logPath) {
        super();
        this.logPath = logPath;
        this.currentSize = 0;
    }

    start() {
        if (!fs.existsSync(this.logPath)) {
            console.error(`Log file not found: ${this.logPath}`);
            return;
        }

        this.currentSize = fs.statSync(this.logPath).size;
        
        fs.watch(this.logPath, (event) => {
            if (event === 'change') {
                this.readNewLogs();
            }
        });
    }

    readNewLogs() {
        const stats = fs.statSync(this.logPath);
        if (stats.size < this.currentSize) {
            this.currentSize = 0; // Log rotated
        }

        const stream = fs.createReadStream(this.logPath, {
            start: this.currentSize,
            end: stats.size
        });

        stream.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) this.processLine(line);
            });
        });

        this.currentSize = stats.size;
    }

    processLine(line) {
        this.emit('line', line);
        
        // Simple metric parsing logic (to be expanded)
        if (line.includes('print_info: model')) {
            this.emit('model_load', line);
        }
    }
}
