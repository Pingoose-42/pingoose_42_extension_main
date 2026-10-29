// Logout warning presentation and countdown; the service decides how actions proceed.
const { GLib, GObject, St, Clutter } = imports.gi;
const ModalDialog = imports.ui.modalDialog;

var SlotConfirmDialog = GObject.registerClass(
    class SlotConfirmDialog extends ModalDialog.ModalDialog {
        _init(slots, onAction, evaluations = [], pendingFeedback = []) {
            super._init({ styleClass: 'pingoose-modal-dialog' });
            this._onAction = onAction;
            this._decided = false;
            this._canCloseSlots = slots.length > 0;
            const box = new St.BoxLayout({
                vertical: true,
                style: 'width: 460px; spacing: 16px; padding: 16px;',
            });
            box.add_child(new St.Icon({ icon_name: 'dialog-warning-symbolic', icon_size: 32 }));
            box.add_child(
                new St.Label({
                    text: 'Check evaluations before logging out',
                    style: 'font-weight: bold; font-size: 1.3em;',
                })
            );
            const list = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
            const text = (value, red = false) => {
                const label = new St.Label({
                    text: value,
                    style: 'max-width: 440px;' + (red ? 'color: #ef5350;' : ''),
                });
                label.clutter_text.line_wrap = true;
                list.add_child(label);
            };
            const format = (value) => new Date(value).toLocaleString('en-GB');
            if (slots.length) text(`Open slots · ${slots.length}`);
            for (const slot of slots) text(`${format(slot.start)} – ${format(slot.end)}`);
            if (evaluations.length) {
                text(`Scheduled evaluations · ${evaluations.length}`, true);
                for (const evaluation of evaluations)
                    text(
                        `${evaluation.devTest ? '[Test] ' : ''}${evaluation.project || 'Evaluation'}
${format(evaluation.start)}${evaluation.end ? ' – ' + format(evaluation.end) : ''}`,
                        true
                    );
                if (slots.length) text('Closing open slots does not cancel these evaluations.');
            }
            if (pendingFeedback.length) {
                text(`Feedback confirmation pending · ${pendingFeedback.length}`, true);
                for (const evaluation of pendingFeedback) {
                    const role = ['evaluator', 'corrector'].includes(evaluation.kind)
                        ? 'Evaluator'
                        : 'Evaluatee';
                    text(
                        `${evaluation.devTest ? '[Test] ' : ''}${evaluation.project || 'Evaluation'} · ${role}
${format(evaluation.begin)}
${(evaluation.users || []).map((login) => '@' + login).join(', ')}`,
                        true
                    );
                }
                text(
                    'These past evaluation cards have not been marked as feedback complete in Pingoose. Check Intra before leaving.'
                );
            }
            const scroll = new St.ScrollView({
                style: 'max-height: 260px;',
                overlay_scrollbars: false,
            });
            scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            scroll.add_actor(list);
            box.add_child(scroll);
            this._status = new St.Label({ text: '', style: 'max-width: 460px;' });
            this._status.clutter_text.line_wrap = true;
            box.add_child(this._status);
            this.contentLayout.add_child(box);
            this._buttons();
            this._deadline = GLib.get_monotonic_time() + 60000000;
            const tick = () => {
                const seconds = Math.max(
                    0,
                    Math.ceil((this._deadline - GLib.get_monotonic_time()) / 1000000)
                );
                this._status.text = `Logging out in ${seconds}s without resolving these items.`;
                if (!seconds) {
                    this._timer = 0;
                    this._choose('keep');
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            };
            tick();
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);
            this.connect('destroy', () => this._stopCountdown());
        }
        _buttons() {
            this.setButtons([
                ...(this._canCloseSlots
                    ? [{ label: 'Close Slots & Log Out', action: () => this._choose('close') }]
                    : []),
                { label: 'Log Out Anyway', action: () => this._choose('keep') },
                {
                    label: 'Cancel',
                    action: () => this._choose('cancel'),
                    key: Clutter.KEY_Escape,
                    default: true,
                },
            ]);
        }
        _stopCountdown() {
            if (this._timer) GLib.source_remove(this._timer);
            this._timer = 0;
        }
        _choose(action) {
            if (this._decided) return;
            this._decided = true;
            this._stopCountdown();
            if (action === 'close') {
                this.setButtons([]);
                this._status.text = 'Closing slots…';
            }
            this._onAction(action);
        }
        failed() {
            this._decided = false;
            this._status.text =
                'Some slots could not be closed. You are still logged in.\nTry again, log out anyway, or cancel.';
            this._buttons();
        }
    }
);
