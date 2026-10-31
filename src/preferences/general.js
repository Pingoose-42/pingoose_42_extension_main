const { Gtk, Gio, GLib } = imports.gi;
const Common = imports.misc.extensionUtils.getCurrentExtension().imports.preferences.common;
const Themes = imports.misc.extensionUtils.getCurrentExtension().imports.models.themes;
function build(settings) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
    Common.sectionHeading(box, 'Panel & Shortcuts', false);
    imports.misc.extensionUtils
        .getCurrentExtension()
        .imports.preferences.panelShortcut.append(box, settings);
    const theme = new Gtk.ComboBoxText();
    for (const [id, label] of Themes.choices) theme.append(id, label);
    settings.bind('theme', theme, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Color mode', theme);
    const transparency = Gtk.SpinButton.new_with_range(0, 80, 1);
    transparency.numeric = true;
    transparency.tooltip_text =
        '0% = Solid. 80% = Most transparent. Only panel backgrounds change; text and input fields stay opaque.';
    settings.bind('panel-transparency', transparency, 'value', Gio.SettingsBindFlags.DEFAULT);
    const transparencyRow = new Gtk.Box({ spacing: 24 });
    transparencyRow.append(
        new Gtk.Label({
            label: 'Panel _transparency (0–80%)',
            use_underline: true,
            mnemonic_widget: transparency,
            xalign: 0,
            hexpand: true,
            wrap: true,
        })
    );
    transparencyRow.append(transparency);
    box.append(transparencyRow);
    box.append(
        new Gtk.Label({
            label: 'Changes panel backgrounds only. Text and input fields stay opaque and readable.',
            xalign: 0,
            wrap: true,
        })
    );
    const autoClose = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('auto-close-panels', autoClose, 'active', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Auto-close side panels', autoClose);
    Common.sectionHeading(box, 'Web Browser & Links');
    const openInBrowser = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('open-in-browser', openInBrowser, 'active', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Open links in default browser', openInBrowser);

    Common.sectionHeading(box, 'Animations');
    const animations = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('panel-animations', animations, 'active', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Panel animations', animations);
    const animationDuration = Gtk.SpinButton.new_with_range(100, 500, 25);
    settings.bind(
        'panel-animation-duration',
        animationDuration,
        'value',
        Gio.SettingsBindFlags.DEFAULT
    );
    settings.bind('panel-animations', animationDuration, 'sensitive', Gio.SettingsBindFlags.GET);
    Common.row(box, 'Animation duration (100–500 ms)', animationDuration);
    Common.sectionHeading(box, 'Logtime');
    const secondsMode = new Gtk.ComboBoxText();
    secondsMode.append('truncate', 'Whole minutes per day');
    secondsMode.append('sum', 'Include seconds in total');
    settings.bind('logtime-seconds-mode', secondsMode, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Seconds calculation', secondsMode);
    const dailyLimit = new Gtk.ComboBoxText();
    dailyLimit.append('12h', 'Maximum 12 hours per day');
    dailyLimit.append('all', 'All server-recorded time');
    settings.bind('logtime-daily-limit', dailyLimit, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Daily time limit', dailyLimit);
    Common.sectionHeading(box, 'Agenda & Calendar');
    const calendarSync = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('sync-agenda-calendar', calendarSync, 'active', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Sync agenda with Calendar', calendarSync);
    imports.misc.extensionUtils
        .getCurrentExtension()
        .imports.preferences.calendarRetention.append(box, settings);
    const calendarScope = new Gtk.ComboBoxText();
    calendarScope.append('registered', 'Registered agendas only');
    calendarScope.append('all', 'All agendas');
    settings.bind(
        'agenda-calendar-scope',
        calendarScope,
        'active-id',
        Gio.SettingsBindFlags.DEFAULT
    );
    Common.row(box, 'Agendas to sync', calendarScope);
    const manageCalendar = new Gtk.Button({ label: 'Management' });
    let managementWindow = null;
    manageCalendar.connect('clicked', () => {
        if (!managementWindow) {
            managementWindow = new Gtk.Window({
                title: 'Agenda Management',
                transient_for: box.get_root(),
                destroy_with_parent: true,
                modal: true,
                default_width: 640,
                default_height: 600,
            });
            const content = imports.misc.extensionUtils
                .getCurrentExtension()
                .imports.preferences.management.build(settings);
            content.margin_top =
                content.margin_bottom =
                content.margin_start =
                content.margin_end =
                    24;
            managementWindow.set_child(Common.scrollPage(content));
            const window = managementWindow;
            const close = () => {
                if (managementWindow === window) managementWindow = null;
                window.destroy();
            };
            // Use a real GTK button, independent of window-manager decorations.
            const header = new Gtk.HeaderBar({ show_title_buttons: false });
            header.set_title_widget(new Gtk.Label({ label: 'Agenda Management' }));
            const closeButton = new Gtk.Button({
                icon_name: 'window-close-symbolic',
                tooltip_text: 'Close',
            });
            closeButton.add_css_class('flat');
            closeButton.connect('clicked', close);
            header.pack_end(closeButton);
            window.set_titlebar(header);
            window.connect('close-request', () => {
                close();
                return true;
            });
        }
        managementWindow.present();
    });
    box.append(manageCalendar);
    const calendarStatus = new Gtk.Label({ xalign: 0, wrap: true });
    settings.bind('agenda-calendar-status', calendarStatus, 'label', Gio.SettingsBindFlags.GET);
    box.append(calendarStatus);
    Common.sectionHeading(box, 'Updates');
    const checkUpdate = new Gtk.Button({ label: 'Check for Updates' });
    checkUpdate.connect('clicked', () => {
        settings.set_string('update-check-request', GLib.uuid_string_random());
        Gio.Settings.sync();
    });
    box.append(checkUpdate);
    const autoUpdate = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('auto-update', autoUpdate, 'active', Gio.SettingsBindFlags.DEFAULT);
    Common.row(box, 'Auto Update', autoUpdate);
    Common.sectionHeading(box, 'Account & Data');
    const agendaReset = new Gtk.Button({ label: 'Agenda Reset' });
    agendaReset.connect('clicked', () =>
        Common.confirm(
            box,
            'Reset agenda cards?',
            'Restore deleted agenda cards and request the current agenda from Intra. This does not change subscriptions or submit feedback.',
            'Reset',
            () => {
                settings.set_strv('dismissed-agenda-ids', []);
                settings.set_string('agenda-reset-request', GLib.uuid_string_random());
                Gio.Settings.sync();
            }
        )
    );
    box.append(agendaReset);
    const logout = new Gtk.Button({ label: 'Logout Intra' });
    logout.connect('clicked', () =>
        Common.confirm(
            box,
            'Log out of 42 Intra?',
            'You will need to log in again to view your Intra information.',
            'Log Out',
            () => {
                settings.set_string('logout-request', GLib.uuid_string_random());
                Gio.Settings.sync();
            }
        )
    );
    box.append(logout);
    const reset = new Gtk.Button({ label: 'Reset All Data' });
    box.append(reset);
    const status = new Gtk.Label({ label: '', xalign: 0, wrap: true });
    box.append(status);
    const refresh = () => {
        const value = settings.get_string('reset-status');
        reset.sensitive = !['pending', 'running'].includes(value);
        status.label =
            {
                pending: 'Reset requested. Enable the extension if it is disabled.',
                running: 'Resetting…',
                done: 'Reset complete. All local data was deleted and you are logged out.',
                error: 'Reset failed or was interrupted. Enable the extension and try again.',
            }[value] || '';
    };
    reset.connect('clicked', () =>
        Common.confirm(
            box,
            'Reset all data?',
            'This permanently deletes all notes, TODO lists, chat history, notifications, cached profiles and website login data. Settings return to their defaults and Intra is logged out. Server-side projects and evaluation slots are not changed.',
            'Reset All Data',
            () => {
                settings.set_string('reset-status', 'pending');
                settings.set_string('reset-request', GLib.uuid_string_random());
                Gio.Settings.sync();
                refresh();
            }
        )
    );
    let signal = 0;
    box.connect('map', () => {
        if (!signal) signal = settings.connect('changed::reset-status', refresh);
        refresh();
    });
    box.connect('unmap', () => {
        if (signal) settings.disconnect(signal);
        signal = 0;
    });
    refresh();
    return box;
}
