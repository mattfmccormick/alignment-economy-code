import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/', label: 'Wallet', icon: '◉' },
  { to: '/send', label: 'Send', icon: '↗' },
  { to: '/tag', label: 'Tag', icon: '⬡' },
  { to: '/verify', label: 'Verify', icon: '✓' },
  { to: '/more', label: 'More', icon: '⋯' },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-navy border-t border-navy-light">
      <div className="max-w-lg mx-auto flex justify-around">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `flex flex-col items-center py-2 px-3 text-xs transition-colors ${
                isActive ? 'text-teal' : 'text-gray-400 hover:text-gray-200'
              }`
            }
          >
            <span className="text-lg mb-0.5">{tab.icon}</span>
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
