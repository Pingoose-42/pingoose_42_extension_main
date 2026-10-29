// Decode the IPC protocol without depending on GTK, WebKit or a Worker instance.
var Router = class Router {
    constructor(actions) {
        this.actions = actions;
    }

    dispatch(command, timestamp = 0) {
        if (typeof command !== 'string' || command.length > 4096) return;
        let presentation;
        while ((presentation = /^present:(\d{1,10}):(.+)$/.exec(command))) {
            timestamp = Number(presentation[1]);
            if (timestamp > 0xffffffff) return;
            command = presentation[2];
        }
        const exact = {
            'agenda:refresh': 'refreshAgenda',
            refresh: 'refresh',
            'reset-all': 'reset',
            'service:close': 'closeServices',
            'evaluations:check': 'checkEvaluations',
            quit: 'quit',
            diagnose: 'diagnose',
            logout: 'logout',
            login: 'login',
            show: 'show',
            hide: 'hide',
        };
        if (Object.prototype.hasOwnProperty.call(exact, command)) {
            this.actions[exact[command]](timestamp);
            return;
        }
        for (const [prefix, action] of [
            ['favorites:clusters:', 'clusters'],
            ['chat:lookup:', 'chatLookup'],
            ['slots:create:', 'createSlots'],
            ['project:open:', 'project'],
            ['service:open:', 'service'],
        ]) {
            if (!command.startsWith(prefix)) continue;
            let payload;
            try {
                payload = JSON.parse(command.slice(prefix.length));
            } catch (_) {
                this.actions.invalid?.(action);
                return;
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                this.actions.invalid?.(action);
                return;
            }
            this.actions[action](payload, timestamp);
            return;
        }
        const subscription = /^agenda:(subscribe|unsubscribe):(\d+)$/.exec(command);
        if (subscription) {
            this.actions.subscription(subscription[2], subscription[1]);
            return;
        }
        const slots = /^slots:(list|all|future|close:(\d+))$/.exec(command);
        if (slots) {
            this.actions.slots(slots[2] ? 'close' : slots[1], slots[2]);
            return;
        }
        if (['slots:open-auto', 'slots:open-5', 'slots:open-30m'].includes(command)) {
            this.actions.autoSlots(command === 'slots:open-30m');
            return;
        }
        if (command.startsWith('feedback:')) this.actions.feedback(command.slice(9));
    }
};
