// Intercept GNOME 42 logout to check slots and evaluations before continuing.
const Main = imports.ui.main;
const EndSessionDialog = imports.ui.endSessionDialog;
const {SlotConfirmDialog} = imports.misc.extensionUtils.getCurrentExtension().imports.ui.logoutDialog;

var SystemSessionHook = class SystemSessionHook {
    constructor(request, authenticated, warningEnabled = () => true, evaluations = () => []) {
        this._request = request; this._authenticated = authenticated; this._warningEnabled = warningEnabled; this._evaluations=evaluations;
    }
    enable() {
        const proto = EndSessionDialog.EndSessionDialog.prototype;
        this._original = proto._confirm;
        const hook = this;
        this._replacement = function(signal) {
            if (signal !== 'ConfirmedLogout' || !hook._authenticated() || !hook._warningEnabled()) return hook._original.call(this, signal);
            if (hook._pending) return;
            hook._pending = true;
            hook._native = this;
            this._stopTimer();
            this.close(true);
            const original = hook._original;
            const proceed = () => { hook._finish(); original.call(this, signal); };
            try {
                hook._request('slots:list', result => {
                    if (!hook._pending) return;
                    if (result.error || !Array.isArray(result.rows)) {
                        Main.notify('42Intra', 'Unable to check evaluation slots. Check Intra before leaving.');
                    }
                    const slots=Array.isArray(result.rows)?result.rows:[];
                    const future = slots.filter(slot => !slot.matched && Date.parse(slot.end) > Date.now());
                    const evaluations=slots.filter(slot=>slot.matched && Date.parse(slot.end)>Date.now());
                    if(result.evaluationError)Main.notify('Pingoose', 'Could not refresh evaluations. Showing the last known information.');
                    const snapshot=Array.isArray(result.evaluations)?[...result.evaluations,...hook._evaluations().filter(row=>row.devTest)]:hook._evaluations();
                    const cards = snapshot.filter(row => !row.missing && Number.isFinite(Date.parse(row.begin)));
                    const pendingFeedback = cards.filter(row => Date.parse(row.begin) <= Date.now());
                    for (const row of cards.filter(row => Date.parse(row.begin) > Date.now())) {
                        const existing=evaluations.find(slot=>!row.devTest && (String(slot.evaluationId || '')===String(row.id) || Date.parse(slot.start)===Date.parse(row.begin)));
                        if(existing)existing.project=row.project || existing.project;
                        else evaluations.push({...row, start: row.begin, end: null});
                    }
                    if (!future.length && !evaluations.length && !pendingFeedback.length) { proceed(); return; }
                    Main.notify('42Intra · Evaluation reminders', 'Review the pending items before logging out.');
                    hook._dialog = new SlotConfirmDialog(future, action => {
                        if (action === 'keep') proceed();
                        else if (action === 'cancel') { hook._finish(); this.cancel(); }
                        else {
                            try {
                                hook._request('slots:future', response => {
                                    if (!hook._pending) return;
                                    if (response.error || !Array.isArray(response.rows) || response.rows.some(slot => !slot.matched && Date.parse(slot.end) > Date.now()))
                                        hook._dialog.failed();
                                    else proceed();
                                });
                            } catch (e) {
                                logError(e, 'Pingoose slots:future request failed');
                                hook._dialog.failed();
                            }
                        }
                    }, evaluations, pendingFeedback);
                    if (!hook._dialog.open()) { hook._finish(); this.cancel(); }
                });
            } catch (err) {
                logError(err, 'Pingoose slots:list request failed');
                proceed();
            }
        };
        proto._confirm = this._replacement;
    }
    _finish() {
        this._dialog?._stopCountdown();
        this._dialog?.destroy();
        this._dialog = null; this._pending = false; this._native = null;
    }
    disable() {
        const proto = EndSessionDialog.EndSessionDialog.prototype;
        if (proto._confirm === this._replacement) proto._confirm = this._original;
        const native = this._native;
        this._finish();
        native?.cancel();
    }
};
