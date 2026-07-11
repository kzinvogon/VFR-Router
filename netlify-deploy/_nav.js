// Shared nav-bar rendering for secondary pages. Fetches /api/auth/me and
// renders a context-appropriate nav (logged-in vs anonymous).
async function renderNav(activeId) {
  let user = null;
  try {
    const resp = await fetch('/api/auth/me');
    if (resp.ok) {
      const data = await resp.json();
      user = data.user;
    }
  } catch {}

  const header = document.querySelector('header');
  if (!header) return user;
  let nav = header.querySelector('nav');
  if (!nav) { nav = document.createElement('nav'); header.appendChild(nav); }

  const links = [];
  links.push({ id: 'router', label: 'Router', href: '/' });
  if (user) {
    links.push({ id: 'plans', label: 'My Plans', href: '/plans.html' });
    links.push({ id: 'profile', label: 'Profile', href: '/profile.html' });
    if (user.isAdmin) links.push({ id: 'admin', label: 'Admin', href: '/admin.html' });
    links.push({ id: 'contribute', label: 'Contribute', href: '/contribute.html' });
    links.push({ id: 'logout', label: 'Logout', href: '#', onClick: 'logoutClick(event)' });
  } else {
    links.push({ id: 'contribute', label: 'Contribute', href: '/contribute.html' });
    links.push({ id: 'login', label: 'Sign in', href: '/login.html' });
    links.push({ id: 'register', label: 'Register', href: '/register.html' });
  }

  nav.innerHTML = links.map(l => {
    const cls = l.id === activeId ? ' class="active"' : '';
    const click = l.onClick ? ` onclick="${l.onClick}"` : '';
    return `<a${cls} href="${l.href}"${click}>${l.label}</a>`;
  }).join('');

  return user;
}

async function logoutClick(e) {
  e.preventDefault();
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.href = '/';
}
