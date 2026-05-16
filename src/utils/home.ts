import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the actual home directory of the user, even when running with sudo.
 */
export function getActualHomeDir(): string {
    const sudoUser = process.env['SUDO_USER'];
    if (sudoUser && sudoUser !== 'root') {
        // On Linux, the home dir for a user is typically /home/username
        return path.join('/home', sudoUser);
    }
    return os.homedir();
}

export const ACTUAL_HOME = getActualHomeDir();
