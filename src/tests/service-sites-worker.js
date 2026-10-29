const { GLib } = imports.gi;
imports.searchPath.unshift(GLib.build_filenamev([GLib.get_current_dir(), 'src']));
// Deliberately no GNOME Shell imports: this matches the standalone webview process.
const Sites = imports.models.serviceSites;
const project = Sites.normalizeSite('Libft', 'https://projects.intra.42.fr/libft/fixture');
if (!project) throw Error('Project URL rejected');
const defaults = Sites.readSites({ get_string: () => '' });
if (defaults.length !== 2 || defaults[0].name !== 'SUBAK') throw Error('Missing shared defaults');
print('PASS: standalone worker imports, project URL and service defaults');
