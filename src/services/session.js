const { GLib } = imports.gi;
const Main = imports.ui.main;

const STATUS = new Set([
    'authenticated',
    'loading',
    'watching',
    'login-needed',
    'auth-error',
    'permission-error',
    'account-error',
    'rate-limit',
    'retry-wait',
    'network-error',
    'api-error',
    'response-error',
    'storage-error',
    'worker-error',
    'worker-busy',
]);

// Owns account transitions and profile presentation, not domain message routing.
var Controller = class Controller {
    constructor(bridge, indicator, { maintenance, onClear, onAuthenticated, isResetting }) {
        this.bridge = bridge;
        this.indicator = indicator;
        this.maintenance = maintenance;
        this.onClear = onClear;
        this.onAuthenticated = onAuthenticated;
        this.isResetting = isResetting;
        this.listeners = [
            bridge.on('error', (message) => {
                indicator.status.label.text = message;
            }),
            bridge.on('process-exited', () => {
                if (
                    !bridge.isRunning &&
                    !isResetting() &&
                    !['worker-busy', 'worker-error'].includes(bridge.status)
                )
                    indicator.status.label.text =
                        'Intra monitoring stopped. Restart the extension.';
            }),
            bridge.on('profile', (message) => {
                maintenance.observe(message);
                if (!maintenance.active && message.login === GLib.get_user_name())
                    indicator.updateProfile(message);
            }),
            bridge.on('profile-avatar', (message) => indicator.updateAvatar(message.login)),
            bridge.on('study-time', (message) => indicator.updateStudyTime(message)),
            bridge.on('signed-out', () => {
                if (!maintenance.active) onClear();
            }),
            bridge.on('status', (message) => this.status(message)),
            bridge.on('refresh-state', (message) => maintenance.result(message.state)),
        ];
    }

    status(message) {
        if (this.maintenance.active || !STATUS.has(message.state)) return;
        if (message.state === 'account-error') {
            this.onClear();
            Main.notify(
                'Pingoose',
                'Your Intra ID must match the current PC username. Information from another account cannot be loaded.'
            );
            return;
        }
        if (message.state === 'login-needed') {
            this.indicator.setLoginOnly(true);
            return;
        }
        if (['authenticated', 'watching'].includes(message.state)) {
            const changed = this.indicator.loginOnly;
            this.indicator.setLoginOnly(false);
            this.onAuthenticated(changed);
        }
        this.indicator.status.label.text = message.state;
    }

    destroy() {
        this.listeners.forEach((unsubscribe) => unsubscribe());
    }
};
