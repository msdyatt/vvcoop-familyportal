// Stands in for what the signed-in portal pages send (buildFrameState in lib/native-frame.ts):
// the same shape, pointed at these test pages. Two sections, so the Menu can switch.
(function () {
  if (!window.VVNative) return;
  function d(id, label, file, icon, section) {
    var x = { id: id, label: label, href: '/test-frame/' + file, icon: icon };
    if (section) x.section = section;
    return x;
  }
  var home = d('home', 'Home', 'tabs.html', 'home');
  var photos = d('photos', 'Photos', 'photos.html', 'photos');
  var messages = d('messages', 'Messages', 'messages.html', 'messages');
  var teaching = d('teacher-home', 'Teaching', 'teacher.html', 'teach');
  var state = {
    signedIn: true,
    unread: 3,
    home: '/test-frame/tabs.html',
    bar: [home, photos, messages],
    menu: [
      { title: 'Family', items: [home] },
      { title: 'Anywhere in the portal', items: [photos, messages] },
      { title: 'Teacher', items: [teaching] }
    ]
  };
  VVNative.post('state', state);
  VVNative.post('notifications', { unread: 2 });
  VVNative.post('title', { title: document.title.split(' | ')[0] });
  VVNative.on('action', function (a) {
    VVNative.post('log', { text: 'action ' + a.name });
    var out = document.getElementById('out');
    if (out) out.textContent = 'action from the Menu: ' + a.name;
  });
})();
