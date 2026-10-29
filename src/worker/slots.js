var Controller = class Controller {
    constructor({ context, allowedURI, current, settings, emit }) {
        this.context = context;
        this.allowedURI = allowedURI;
        this.current = current;
        this.settings = settings;
        this.emit = emit;
        this.service = null;
    }

    request(action, id = null, payload = null) {
        const identity = this.current();
        if (!identity) {
            this.error('Log in to manage slots.');
            return;
        }
        this.service ||= new imports.services.slotsService.SlotsService(
            this.context,
            this.allowedURI
        );
        if (this.service.busy) {
            if (action === 'create') this.error('A slot request is already running.');
            return;
        }
        this.service.run(
            action,
            id,
            (result) => {
                if (this.current() === identity) this.emit({ type: 'slots', ...result });
            },
            payload
        );
    }

    automatic(single) {
        if (!imports.models.featureFlags.enabled(this.settings, 'hidden-auto-slots')) {
            this.error('Automatic slot creation is disabled.');
            return;
        }
        if (!this.current()) {
            this.error('Log in to manage slots.');
            return;
        }
        let payload;
        try {
            payload = imports.models.slotSchedule.build(
                Date.now(),
                this.settings.get_int('auto-slot-duration-units'),
                this.settings.get_int('auto-slot-interval-units'),
                single ? 1 : this.settings.get_int('auto-slot-count')
            );
        } catch (error) {
            this.error(error.message);
            return;
        }
        this.request('create-5', null, payload);
    }

    error(error) {
        this.emit({ type: 'slots', error });
    }

    clear() {
        this.service?.close();
        this.service = null;
    }
};
