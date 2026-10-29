const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
var Controller = class Controller {
    ask(done) {
        if (this.source) return;
        this.source = new MessageTray.Source('Pingoose', 'x-office-calendar-symbolic');
        Main.messageTray.add(this.source);
        const notification = new MessageTray.Notification(
            this.source,
            'Enable agenda calendar?',
            'The Pingoose calendar is disabled or hidden. Enable it and sync your agenda?'
        );
        notification.setResident(true);
        let answered = false;
        const answer = (value) => {
            if (answered) return;
            answered = true;
            done(value);
            notification.destroy();
        };
        notification.addAction('Yes', () => answer(true));
        notification.addAction('No', () => answer(false));
        this.source.connect('destroy', () => {
            this.source = null;
            if (!answered) {
                answered = true;
                done(false);
            }
        });
        this.source.showNotification(notification);
    }
    destroy() {
        this.source?.destroy();
    }
};
