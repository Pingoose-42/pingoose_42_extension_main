const { GLib } = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Flags = Me.imports.models.featureFlags;

var Controller = class Controller {
    constructor(menu, settings, indicator, { evaluations, agenda, notifications, maintenance }) {
        this.settings = settings;
        this.indicator = indicator;
        this.evaluations = evaluations;
        this.agenda = agenda;
        this.notifications = notifications;
        this.menu = menu;
        this.item = Me.imports.dev.devOptions.addOptions(
            menu,
            () =>
                notifications.onNotificationMessage({
                    type: 'notification',
                    id: `test:${GLib.get_monotonic_time()}`,
                    test: true,
                    body: 'Test notification',
                }),
            (row) => this.addEvaluation(row),
            settings,
            (row) => this.addAgenda(row),
            () => {
                menu.close();
                if (Flags.enabled(settings, 'hidden-dev-options')) maintenance.test();
            }
        );
        this.sync();
    }

    sync() {
        this.item.visible = Flags.enabled(this.settings, 'hidden-dev-options');
    }

    addEvaluation(row) {
        if (!Flags.enabled(this.settings, 'hidden-dev-options')) return;
        const profile = this.indicator.lastProfile;
        const login = profile?.login || GLib.get_user_name();
        const seat = String(profile?.location || GLib.get_host_name())
            .split('.')[0]
            .toLowerCase();
        row.users = [login];
        row.seats = { [login]: /^c\d+r\d+s\d+$/.test(seat) ? seat : 'Unavailable' };
        row.names = profile?.name ? { [login]: profile.name } : {};
        row.devSelf = true;
        row.avatars = [login];
        row.chatConfirmedAt = { [login]: Date.now() };
        this.evaluations.addTest(row);
        this.menu.close();
        this.notifications.onNotificationMessage(Me.imports.models.evaluations.notification(row));
    }

    addAgenda(row) {
        if (!Flags.enabled(this.settings, 'hidden-dev-options')) return;
        this.agenda.addTest(row);
        this.menu.close();
        this.notifications.onNotificationMessage({
            type: 'notification',
            id: row.id,
            category: 'agenda',
            body: 'New agenda event · Test Agenda',
        });
    }
};
