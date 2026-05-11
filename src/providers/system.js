import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class SystemProvider {
    async getRam() {
        const total = os.totalmem();
        const used = total - os.freemem();
        return {
            used: Math.round(used / 1024 / 1024 / 1024 * 10) / 10,
            total: Math.round(total / 1024 / 1024 / 1024 * 10) / 10
        };
    }

    async getCpu() {
        // Implementation for CPU load, temp and frequency
        return { utilization: 0, temperature: 0, frequency: 0 };
    }

    async getGpu() {
        // Implementation for ROCm/AMD SMI parsing
        try {
            const { stdout } = await execAsync('rocm-smi --showuse --showmeminfo vram --showtemp --showpower --json');
            const data = JSON.parse(stdout);
            const gpu0 = data['card0'] || Object.values(data)[0];
            
            return {
                utilization: parseInt(gpu0['GPU use (%)'] || '0'),
                memoryUsed: parseInt(gpu0['VRAM Total Used Memory (B)'] || '0') / 1024 / 1024 / 1024,
                memoryTotal: parseInt(gpu0['VRAM Total Memory (B)'] || '0') / 1024 / 1024 / 1024,
                temperature: parseInt(gpu0['Temperature (Sensor edge) (C)'] || '0'),
                power: parseFloat(gpu0['Average Graphics Package Power (W)'] || '0'),
                fan: 0,
                tool: 'rocm-smi'
            };
        } catch (e) {
            return { utilization: 0, memoryUsed: 0, memoryTotal: 0, temperature: 0, power: 0, fan: 0, tool: 'none' };
        }
    }
}
