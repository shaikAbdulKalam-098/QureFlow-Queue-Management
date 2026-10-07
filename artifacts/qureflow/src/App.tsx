import { useMemo, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, Check, CheckCircle2, ChevronDown,
  CircleHelp, Clock3, HeartPulse, History, LayoutDashboard, LineChart, ListFilter, LogIn,
  LogOut, Menu, Plus, RefreshCw, ShieldCheck, Stethoscope, Users, X,
} from 'lucide-react';
import {
  CurrentUserRole,
  QueueActionInputAction,
  SimulationInputAction,
  getGetAdminOverviewQueryKey,
  getGetAnalyticsQueryKey,
  getGetCurrentUserQueryKey,
  getGetDashboardQueryKey,
  getGetDirectoryQueryKey,
  getGetPatientHistoryQueryKey,
  getListNotificationsQueryKey,
  getListQueueEntriesQueryKey,
  getTrackQueueEntryQueryKey,
  useCreateDemoSession,
  useCreateQueueEntry,
  useEndDemoSession,
  useGetAdminOverview,
  useGetAnalytics,
  useGetCurrentUser,
  useGetDashboard,
  useGetDirectory,
  useGetPatientHistory,
  useListNotifications,
  useListQueueEntries,
  useMarkNotificationRead,
  usePerformQueueAction,
  useSimulateQueue,
  useTrackQueueEntry,
} from '@workspace/api-client-react';
import type { CurrentUser, Dashboard, Notification, Queue, QueueEntry } from '@workspace/api-client-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true } },
});

const roles = [
  { role: CurrentUserRole.PATIENT, label: 'Patient', icon: HeartPulse },
  { role: CurrentUserRole.STAFF, label: 'Clinic staff', icon: Users },
  { role: CurrentUserRole.DOCTOR, label: 'Doctor', icon: Stethoscope },
  { role: CurrentUserRole.ADMIN, label: 'Administrator', icon: ShieldCheck },
];

const roleHomes: Record<string, string> = {
  PATIENT: '/dashboard', STAFF: '/staff', DOCTOR: '/doctor', ADMIN: '/admin',
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function formatDate(value?: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}
function titleCase(value?: string | null) {
  return (value ?? '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function Button({ children, variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'outline' | 'danger' }) {
  return <button {...props} className={cx('button', `button-${variant}`, className)}>{children}</button>;
}
function Brand({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className={cx('brand', compact && 'brand-compact')} data-testid="link-home-brand">
    <span className="brand-mark"><HeartPulse size={19} strokeWidth={2.4} /></span>
    <span className="brand-name">qureflow<span className="brand-period">.</span></span>
  </Link>;
}
function PageTitle({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="page-title">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{detail && <p>{detail}</p>}</div>
    {action && <div className="title-action">{action}</div>}
  </div>;
}
function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton-stack" aria-label="Loading content" role="status">
    {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row"><i className="skeleton" /><div><i className="skeleton" /><i className="skeleton short" /></div></div>)}
  </div>;
}
function QueryError({ retry }: { retry: () => void }) {
  return <div className="state-card"><div className="state-icon state-error"><CircleHelp size={21} /></div><h3>We couldn’t load this view</h3><p>Your clinic data is still safe. Check your connection and try again.</p><Button variant="outline" onClick={retry}><RefreshCw size={15} /> Try again</Button></div>;
}
function EmptyState({ title, text, icon: Icon = Activity }: { title: string; text: string; icon?: typeof Activity }) {
  return <div className="empty-state"><span><Icon size={22} /></span><strong>{title}</strong><p>{text}</p></div>;
}
function StatusPill({ status }: { status: string }) {
  return <span className={cx('status-pill', `status-${status.toLowerCase()}`)}><i />{titleCase(status)}</span>;
}
function Metric({ label, value, note, icon: Icon, trend }: { label: string; value: string | number; note?: string; icon: typeof Activity; trend?: 'up' | 'down' }) {
  return <article className="metric-card">
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={17} /></span></div>
    <div className="metric-value" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</div>
    {note && <div className={cx('metric-note', trend === 'up' && 'note-up', trend === 'down' && 'note-down')}>{trend === 'up' ? <ArrowUpRight size={13} /> : trend === 'down' ? <ArrowDownRight size={13} /> : null}{note}</div>}
  </article>;
}
function useDemoRole() {
  const [, setLocation] = useLocation();
  const client = useQueryClient();
  const demo = useCreateDemoSession();
  const start = (role: CurrentUserRole) => demo.mutate({ data: { role } }, {
    onSuccess: (user) => {
      client.setQueryData(getGetCurrentUserQueryKey(), user);
      client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      setLocation(roleHomes[user.role] ?? '/dashboard');
    },
  });
  return { start, pending: demo.isPending, error: demo.isError };
}
function DemoRoleButtons({ compact = false }: { compact?: boolean }) {
  const demo = useDemoRole();
  if (!import.meta.env.DEV) return null;
  return <div className={cx('demo-grid', compact && 'demo-grid-compact')}>
    {roles.map(({ role, label, icon: Icon }) => <button data-testid={`button-demo-${role.toLowerCase()}`} key={role} className="demo-role" disabled={demo.pending} onClick={() => demo.start(role)}>
      <span><Icon size={16} /></span><span>{label}</span><ArrowRight size={14} className="demo-arrow" />
    </button>)}
    {demo.error && <p className="inline-error">Demo access is unavailable right now. Please try again.</p>}
  </div>;
}

function PublicHeader() {
  return <header className="public-header wrap">
    <Brand />
    <nav className="public-nav" aria-label="Main navigation">
      <a href="#how-it-works">How it works</a><a href="#live-queues">Live queues</a>
      <Link href="/sign-in" className="nav-signin">Sign in <ArrowRight size={15} /></Link>
    </nav>
  </header>;
}
function HomePage() {
  const directory = useGetDirectory({ query: { queryKey: getGetDirectoryQueryKey(), refetchInterval: 15_000 } });
  const [joiningQueueId, setJoiningQueueId] = useState<number | null>(null);
  const join = useCreateQueueEntry();
  const [, setLocation] = useLocation();
  const client = useQueryClient();
  const queueList = directory.data?.queues ?? [];
  const liveQueue = queueList.find((queue) => queue.isOpen) ?? queueList[0];
  const liveWait = liveQueue ? Math.max(0, liveQueue.waitingCount * liveQueue.averageDurationMinutes + liveQueue.delayMinutes) : null;
  const joinQueue = (queueId: number) => {
    setJoiningQueueId(queueId);
    join.mutate({ data: { queueId } }, {
    onSuccess: (entry) => {
      setJoiningQueueId(null);
      client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      client.invalidateQueries({ queryKey: getListQueueEntriesQueryKey() });
      setLocation(`/track/${entry.id}`);
    },
    onError: () => setJoiningQueueId(null),
  });
  };
  return <main className="landing">
    <PublicHeader />
    <section className="hero wrap">
      <div className="hero-copy page-enter">
        <div className="live-label"><span className="live-dot" /> THE CLINIC, WITHOUT THE WAITING ROOM</div>
        <h1>Care moves better<br />when you <em>know</em><br />what comes next.</h1>
        <p>Join your clinic’s queue from wherever you are. Follow your place in line, get a clear wait estimate, and arrive when it’s your turn.</p>
        <div className="hero-actions"><Link href="/sign-up" className="button button-primary">Get started <ArrowRight size={16} /></Link><a href="#live-queues" className="text-link">See live queues <ArrowDownRight size={15} /></a></div>
        <div className="hero-foot"><span><ShieldCheck size={15} /> Your place, kept private</span><span><Activity size={15} /> Updates in real time</span></div>
      </div>
      <div className="hero-art page-enter" aria-label="Illustration of a patient queue status card">
        <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
        <div className="queue-ticket">
          <div className="ticket-top"><span className="ticket-brand"><HeartPulse size={16} /> QUREFLOW</span><span className="ticket-status"><i /> LIVE</span></div>
          <div className="ticket-dept">{liveQueue?.departmentName ?? 'CLINIC QUEUE'} <span>·</span> {liveQueue?.doctorName ?? 'Live clinic directory'}</div>
          <div className="ticket-token"><small>NOW SERVING</small><strong>{liveQueue?.currentToken ? <>Q<span>{String(liveQueue.currentToken).padStart(3, '0')}</span></> : <span>—</span>}</strong></div>
          <div className="ticket-progress"><div><span>Patients waiting</span><b>{liveQueue?.waitingCount ?? '—'} <small>in line</small></b></div><div className="progress-track"><i style={{ width: `${liveQueue ? Math.max(8, Math.min(100, liveQueue.waitingCount * 8)) : 8}%` }} /></div></div>
          <div className="ticket-bottom"><span><Clock3 size={15} /> Est. wait</span><b>{liveWait !== null ? `~ ${liveWait} min` : '—'}</b></div>
          <div className="ticket-updated"><span className="tiny-dot" /> {directory.dataUpdatedAt ? `Updated ${formatTime(new Date(directory.dataUpdatedAt).toISOString())}` : 'Connecting to live directory'}</div>
        </div>
        <div className="float-note note-left"><span className="note-check"><Check size={15} /></span><div><b>Know when to arrive</b><small>Updates from the clinic queue.</small></div></div>
        <div className="float-note note-right"><span className="note-pulse" /><div><b>Live queue</b><small>Updates every few seconds</small></div></div>
        <div className="art-caption">A little more certainty, all the way through.</div>
      </div>
    </section>
    <section className="trust-strip"><div className="wrap trust-inner"><span className="trust-title">A calmer clinic visit starts before you arrive.</span><span><CheckCircle2 size={16} /> No app download</span><span><CheckCircle2 size={16} /> Live queue updates</span><span><CheckCircle2 size={16} /> Made for real clinic days</span></div></section>
    <section className="live-section wrap" id="live-queues">
      <div className="section-heading"><div><div className="eyebrow">THE WAIT, MADE VISIBLE</div><h2>Queues open right now</h2><p>Queue availability and wait estimates update from the clinic.</p></div><span className="live-updating"><span className="live-dot" /> LIVE</span></div>
      {directory.isLoading ? <Skeleton rows={3} /> : directory.isError ? <QueryError retry={() => directory.refetch()} /> : queueList.length === 0 ? <EmptyState title="No open queues at the moment" text="Check back soon for clinic availability." /> :
        <div className="queue-directory">{queueList.map((queue) => <QueuePreview key={queue.id} queue={queue} onJoin={() => joinQueue(queue.id)} joining={joiningQueueId === queue.id} />)}</div>}
      {join.isError && <p className="inline-error">We couldn’t join this queue. Please try again.</p>}
    </section>
    <section className="how-section" id="how-it-works"><div className="wrap how-inner">
      <div><div className="eyebrow">A BETTER KIND OF WAIT</div><h2>Make the time<br />yours again.</h2><p>QureFlow keeps the whole care team in sync, so you can keep your day moving while the clinic keeps yours moving forward.</p></div>
      <div className="steps-list"><div className="how-step"><span>01</span><div><b>Choose your queue</b><p>Find an open department and join in a few taps.</p></div><ArrowRight size={17} /></div><div className="how-step"><span>02</span><div><b>Keep your place</b><p>Follow your position and estimated wait as it changes.</p></div><ArrowRight size={17} /></div><div className="how-step"><span>03</span><div><b>Arrive at the right moment</b><p>We’ll tell you when the doctor is ready for you.</p></div><ArrowRight size={17} /></div></div>
    </div></section>
    <section className="role-invite wrap"><div><div className="eyebrow">FOR EVERY PART OF THE CARE TEAM</div><h2>One queue. Everyone in sync.</h2><p>Clinic staff, doctors, and administrators see the same live picture.</p></div><div className="role-chip-row"><span><Users size={16} /> Front desk</span><span><Stethoscope size={16} /> Clinicians</span><span><ShieldCheck size={16} /> Operations</span></div></section>
    <footer className="public-footer wrap"><Brand compact /><span>Care that keeps your day moving.</span><span>QureFlow · Digital queue care</span></footer>
  </main>;
}
function QueuePreview({ queue, onJoin, joining }: { queue: Queue; onJoin: () => void; joining: boolean }) {
  return <article className="queue-preview" data-testid={`card-queue-${queue.id}`}>
    <div className="queue-preview-top"><span className="queue-icon"><HeartPulse size={18} /></span><span className={cx('open-tag', !queue.isOpen && 'closed-tag')}><i />{queue.isOpen ? 'Accepting patients' : 'Closed'}</span></div>
    <div className="queue-preview-title"><h3>{queue.departmentName}</h3><p>{queue.clinicName}</p></div>
    <div className="queue-doctor">{queue.doctorName}</div>
    <div className="queue-preview-metrics"><div><small>WAITING</small><b>{queue.waitingCount}</b></div><div><small>EST. WAIT</small><b>{Math.max(0, queue.waitingCount * queue.averageDurationMinutes + queue.delayMinutes)} <em>min</em></b></div><div><small>NOW SERVING</small><b>{queue.currentToken ?? '—'}</b></div></div>
    <Button onClick={onJoin} disabled={!queue.isOpen || joining}>{joining ? 'Joining…' : queue.isOpen ? <>Join this queue <ArrowRight size={15} /></> : 'Queue closed'}</Button>
  </article>;
}

function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  return <main className="auth-page">
    <div className="auth-top"><Brand /><Link href="/" className="text-link"><ArrowRight size={15} className="rotate-back" /> Back to home</Link></div>
    <div className="auth-layout">
      <section className="auth-story">
        <div className="auth-leaf"><HeartPulse size={22} /></div><div className="eyebrow">A MORE HUMAN WAIT</div>
        <h1>Care, with a little more <em>clarity.</em></h1><p>See your place in line, know when to arrive, and spend less of your day waiting in a waiting room.</p>
        <div className="auth-assurance"><ShieldCheck size={17} /><span>Your health information stays private and secure.</span></div>
      </section>
      <section className="auth-box">
        <div className="eyebrow">WELCOME TO QUREflow</div><h2>{mode === 'sign-in' ? 'Sign in to your account' : 'Create your QureFlow account'}</h2>
        <p>{mode === 'sign-in' ? 'Continue to your personal queue and clinic updates.' : 'A better clinic visit starts with a few details.'}</p>
        <div className="auth-placeholder"><LogIn size={18} /><div><b>Secure account access</b><small>Sign in is provided by your clinic’s identity service.</small></div></div>
        {import.meta.env.DEV && <><div className="auth-divider"><span />DEVELOPMENT DEMO<span /></div>
          <p className="demo-intro">Explore the live experience with a role-based demo session.</p>
          <DemoRoleButtons compact /></>}
        <p className="auth-switch">{mode === 'sign-in' ? 'New to QureFlow?' : 'Already have an account?'} <Link href={mode === 'sign-in' ? '/sign-up' : '/sign-in'}>{mode === 'sign-in' ? 'Create an account' : 'Sign in'}</Link></p>
      </section>
    </div>
    <div className="auth-foot">QureFlow <span>·</span> A calmer way through care</div>
  </main>;
}

function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const client = useQueryClient();
  const endDemo = useEndDemoSession();
  const [, setLocation] = useLocation();
  const userRole = user.role;
  const links = [
    { label: 'Overview', href: roleHomes[userRole] ?? '/dashboard', icon: LayoutDashboard, show: true },
    { label: 'My history', href: '/history', icon: History, show: userRole === 'PATIENT' },
    { label: 'Queue operations', href: '/staff', icon: Users, show: userRole === 'STAFF' },
    { label: 'My patients', href: '/doctor', icon: Stethoscope, show: userRole === 'DOCTOR' },
    { label: 'Analytics', href: '/analytics', icon: LineChart, show: ['STAFF', 'DOCTOR', 'ADMIN'].includes(userRole) },
    { label: 'Notifications', href: '/notifications', icon: Bell, show: true },
    { label: 'Admin overview', href: '/admin', icon: ShieldCheck, show: userRole === 'ADMIN' },
  ].filter((item) => item.show);
  const logout = () => endDemo.mutate(undefined, { onSuccess: () => {
    client.clear(); setLocation('/');
  } });
  return <div className="app-shell">
    {mobileOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
    <aside className={cx('sidebar', mobileOpen && 'sidebar-open')}>
      <div className="sidebar-brand"><Brand /><button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={19} /></button></div>
      <div className="clinic-switch"><div className="clinic-monogram">Q</div><div><b>QureFlow Clinic</b><small>{titleCase(userRole)} portal</small></div><ChevronDown size={15} /></div>
      <div className="side-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="Workspace navigation">{links.map(({ label, href, icon: Icon }) => <Link key={href} href={href} className={cx('side-link', locationMatches(href) && 'side-link-active')} onClick={() => setMobileOpen(false)} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={18} /><span>{label}</span>{label === 'Notifications' && <span className="nav-unread" />}</Link>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-card"><ShieldCheck size={17} /><div><b>Private by design</b><span>Patient data stays protected.</span></div></div>
        <div className="profile-row"><div className="avatar">{initials(user.name)}</div><div className="profile-meta"><b>{user.name}</b><span>{user.email}</span></div><button onClick={logout} aria-label="End demo session" className="icon-button" data-testid="button-sign-out"><LogOut size={17} /></button></div>
      </div>
    </aside>
    <div className="main-column">
      <header className="topbar"><button className="mobile-menu icon-button" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="crumb"><span>Workspace</span><span>/</span><b>{links.find((l) => locationMatches(l.href))?.label ?? 'QureFlow'}</b></div><div className="topbar-right"><span className="sync-indicator"><i /> Live sync</span><Link href="/notifications" className="icon-button top-notify" aria-label="Notifications"><Bell size={18} /></Link><div className="avatar avatar-small">{initials(user.name)}</div></div></header>
      <main className="content-area page-enter">{children}</main>
      <footer className="app-footer"><span>QureFlow Clinic</span><span>Care in motion <HeartPulse size={13} /></span></footer>
    </div>
  </div>;
}
function locationMatches(href: string) {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname;
  return path === href || (href !== '/dashboard' && path.startsWith(`${href}/`));
}
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase(); }

function NeedAuth({ userQuery }: { userQuery: ReturnType<typeof useGetCurrentUser> }) {
  return <div className="login-gate">
    <span className="gate-icon"><ShieldCheck size={23} /></span><div className="eyebrow">YOUR CLINIC WORKSPACE</div><h1>Sign in to continue</h1>
    <p>This view is connected to your clinic account. Sign in, or open a role-based demo session to explore.</p>
    <div className="gate-actions"><Link href="/sign-in" className="button button-primary">Sign in <ArrowRight size={16} /></Link><Link href="/" className="button button-outline">Back to home</Link></div>
    <div className="gate-demo"><b>DEV ACCESS</b><DemoRoleButtons compact /></div>
    {userQuery.isError && <button className="text-button" onClick={() => userQuery.refetch()}>Retry account check</button>}
  </div>;
}
function Secured({ children }: { children: (user: CurrentUser) => ReactNode }) {
  const userQuery = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey(), retry: false } });
  if (userQuery.isLoading) return <div className="route-loading"><div className="brand-mark"><HeartPulse size={19} /></div><Skeleton rows={4} /></div>;
  if (!userQuery.data) return <NeedAuth userQuery={userQuery} />;
  return <AppShell user={userQuery.data}>{children(userQuery.data)}</AppShell>;
}
function DashboardPage() {
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), refetchInterval: 10_000 } });
  const userQuery = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey(), retry: false } });
  if (!userQuery.data) return <Secured>{() => null}</Secured>;
  if (dashboard.isLoading) return <Secured>{() => <><PageTitle eyebrow="YOUR DAY, AT A GLANCE" title="Good to see you" /><Skeleton rows={5} /></>}</Secured>;
  if (dashboard.isError || !dashboard.data) return <Secured>{() => <QueryError retry={() => dashboard.refetch()} />}</Secured>;
  const data = dashboard.data;
  const patient = data.user.role === 'PATIENT';
  return <Secured>{() => patient ? <PatientDashboard data={data} /> : <TeamDashboard data={data} />}</Secured>;
}
function PatientDashboard({ data }: { data: Dashboard }) {
  return <div className="dashboard-view">
    <PageTitle eyebrow="YOUR CARE, IN FLOW" title={`Good ${greeting()}, ${data.user.name.split(' ')[0]}.`} detail="Here’s the latest on your clinic visit." action={<Link href="/history" className="button button-outline">View history <ArrowRight size={15} /></Link>} />
    {data.activeEntry ? <PatientEntryCard entry={data.activeEntry} queue={data.queue} /> :
      <section className="join-prompt"><span className="prompt-symbol"><Plus size={21} /></span><div><div className="eyebrow">READY WHEN YOU ARE</div><h2>Join a clinic queue</h2><p>Choose an open queue and keep your place from wherever you are.</p></div><Link href="/" className="button button-primary">Find a queue <ArrowRight size={15} /></Link></section>}
    <div className="section-heading section-heading-small"><div><div className="eyebrow">RECENT UPDATES</div><h2>From your clinic</h2></div><Link href="/notifications" className="small-link">All notifications <ArrowRight size={14} /></Link></div>
    <NotificationPreview items={data.recentNotifications ?? []} />
  </div>;
}
function greeting() { const hour = new Date().getHours(); return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'; }
function PatientEntryCard({ entry, queue }: { entry: QueueEntry; queue: Queue | null }) {
  return <section className="patient-entry-card">
    <div className="entry-main">
      <div className="entry-card-head"><span className="entry-live"><i /> LIVE QUEUE</span><StatusPill status={entry.status} /></div>
      <div className="entry-name">{entry.departmentName}<span>{entry.doctorName}</span></div>
      <div className="entry-token-label">YOUR TOKEN</div><div className="entry-token">Q<span>{String(entry.tokenNumber).padStart(3, '0')}</span></div>
      <div className="entry-foot"><span><Clock3 size={15} /> Joined {formatTime(entry.joinedAt)}</span><span>Updated moments ago</span></div>
    </div>
    <div className="entry-side">
      <div className="eta-number">{entry.estimatedWaitMinutes}<small>min</small></div><div className="eta-label">estimated wait</div>
      <div className="position-box"><span>People ahead</span><b>{entry.peopleAhead}</b></div>
      <div className="position-track"><div style={{ width: `${Math.max(8, 100 - Math.min(92, entry.peopleAhead * 12))}%` }} /></div>
      {queue && <small className="queue-name-note">{queue.clinicName} · {queue.name}</small>}
      <Link href={`/track/${entry.id}`} className="button button-light">Track your place <ArrowRight size={15} /></Link>
    </div>
  </section>;
}
function TeamDashboard({ data }: { data: Dashboard }) {
  const stats = data.stats;
  return <div>
    <PageTitle eyebrow={`${titleCase(data.user.role)} PORTAL`} title={`Good ${greeting()}, ${data.user.name.split(' ')[0]}.`} detail="A clear view of the clinic, right now." />
    <div className="metrics-grid">
      <Metric label="Patients today" value={stats.patientsToday} note="Across all departments" icon={Users} />
      <Metric label="Waiting now" value={stats.waitingNow} note="In active queues" icon={Clock3} />
      <Metric label="Completed today" value={stats.completedToday} note="Consultations complete" icon={CheckCircle2} trend="up" />
      <Metric label="Average wait" value={`${stats.averageWaitMinutes} min`} note="Today so far" icon={Activity} />
    </div>
    <div className="dashboard-lower">
      <section className="panel recent-panel"><div className="panel-heading"><div><div className="eyebrow">QUEUE PULSE</div><h2>Recent activity</h2></div><Link href={data.user.role === 'DOCTOR' ? '/doctor' : '/staff'} className="small-link">Open queue <ArrowRight size={14} /></Link></div>
        <EntryTable entries={data.entries?.slice(0, 5) ?? []} />
      </section>
      <section className="panel snapshot-panel"><div className="eyebrow">YOUR SHIFT</div><h2>At a glance</h2><div className="snapshot-line"><span>Average consultation</span><b>{stats.averageConsultationMinutes} min</b></div><div className="snapshot-line"><span>Emergency cases</span><b>{stats.emergencyCases}</b></div><div className="snapshot-line"><span>Cancelled today</span><b>{stats.cancelledToday}</b></div><div className="snapshot-cta"><span>Keep the queue moving.</span><Link href="/analytics">View clinic analytics <ArrowRight size={14} /></Link></div></section>
    </div>
  </div>;
}
function EntryTable({ entries, staff = false, onAction, actionPending = false }: { entries: QueueEntry[]; staff?: boolean; onAction?: (id: number, action: QueueActionInputAction) => void; actionPending?: boolean }) {
  if (!entries.length) return <EmptyState title="No queue activity yet" text="When patients join, their latest queue activity will appear here." />;
  return <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Token</th><th>Department</th><th>Status</th>{staff && <th>Action</th>}</tr></thead><tbody>{entries.map((entry) => <tr key={entry.id} data-testid={`row-entry-${entry.id}`}><td><div className="patient-cell"><span className="avatar avatar-table">{initials(entry.patientName)}</span><b>{entry.patientName}</b></div></td><td><span className="token-small">Q{String(entry.tokenNumber).padStart(3, '0')}</span></td><td>{entry.departmentName}</td><td><StatusPill status={entry.status} /></td>{staff && <td><EntryActionMenu entry={entry} onAction={onAction!} disabled={actionPending} /></td>}</tr>)}</tbody></table></div>;
}
function EntryActionMenu({ entry, onAction, disabled }: { entry: QueueEntry; onAction: (id: number, action: QueueActionInputAction) => void; disabled: boolean }) {
  const action = entry.status === 'WAITING' ? QueueActionInputAction.CALL_NEXT : entry.status === 'CALLED' ? QueueActionInputAction.START : entry.status === 'IN_CONSULTATION' ? QueueActionInputAction.COMPLETE : null;
  if (!action) return <span className="muted-small">No action</span>;
  const label = action === 'CALL_NEXT' ? 'Call' : action === 'START' ? 'Start' : 'Complete';
  return <Button variant="quiet" className="table-action" disabled={disabled} onClick={() => onAction(entry.id, action)}>{label} <ArrowRight size={13} /></Button>;
}

function TrackPage() {
  const params = useParams<{ entryId: string }>();
  const entryId = Number(params.entryId);
  const track = useTrackQueueEntry(entryId, { query: { queryKey: getTrackQueueEntryQueryKey(entryId), enabled: Number.isFinite(entryId) && entryId > 0, refetchInterval: 5_000 } });
  if (track.isLoading) return <div className="track-public"><Brand /><Skeleton rows={4} /></div>;
  if (track.isError || !track.data) return <main className="track-public"><Brand /><QueryError retry={() => track.refetch()} /></main>;
  const entry = track.data;
  const isFinished = ['COMPLETED', 'CANCELLED', 'SKIPPED'].includes(entry.status);
  return <main className="track-public"><Brand /><div className="track-frame">
    <div className="track-head"><div><div className="eyebrow">YOUR LIVE QUEUE</div><h1>You’re in line.</h1></div><StatusPill status={entry.status} /></div>
    <div className="track-clinic"><span className="queue-icon"><HeartPulse size={19} /></span><div><b>{entry.departmentName}</b><small>{entry.doctorName}</small></div><span className="live-updating"><i className="live-dot" /> LIVE</span></div>
    <div className="track-token-label">YOUR TOKEN</div><div className="track-token">Q{String(entry.tokenNumber).padStart(3, '0')}</div>
    {!isFinished ? <div className="track-estimate"><div><span>Estimated wait</span><b>{entry.estimatedWaitMinutes} <small>min</small></b></div><div><span>People ahead</span><b>{entry.peopleAhead}</b></div></div> : <div className="track-finished"><CheckCircle2 size={19} /><span>This queue visit is {titleCase(entry.status).toLowerCase()}.</span></div>}
    <div className="track-progress"><div className="progress-label"><span>Queue position</span><b>{entry.position > 0 ? `${entry.position} of ${entry.position + entry.peopleAhead}` : titleCase(entry.status)}</b></div><div className="progress-track"><i style={{ width: `${isFinished ? 100 : Math.max(7, 100 / (entry.position + entry.peopleAhead || 1))}%` }} /></div></div>
    <div className="track-note"><span className="note-check"><Check size={14} /></span><p>You can go about your day. Keep this page open and we’ll update your place automatically.</p></div>
    <div className="track-meta"><span>Joined at {formatTime(entry.joinedAt)}</span><span>Refreshes automatically</span></div>
    <Link href="/" className="track-home">Explore available queues <ArrowRight size={14} /></Link>
  </div></main>;
}

function HistoryPage() {
  const history = useGetPatientHistory({ query: { queryKey: getGetPatientHistoryQueryKey(), refetchInterval: 30_000 } });
  return <Secured>{(user) => <div><PageTitle eyebrow="YOUR VISITS" title="Queue history" detail="A record of your recent clinic visits." />
    {user.role !== 'PATIENT' ? <div className="panel"><EmptyState title="Patient history is private" text="This view is available to patient accounts." icon={ShieldCheck} /></div> :
      history.isLoading ? <Skeleton rows={5} /> : history.isError ? <QueryError retry={() => history.refetch()} /> : !history.data?.length ? <div className="panel"><EmptyState title="No visits to show yet" text="Your completed queue visits will appear here." icon={History} /></div> :
        <div className="panel history-panel"><div className="history-summary"><span>{history.data.length} visits</span><span>Updated automatically</span></div><div className="table-wrap"><table><thead><tr><th>Visit</th><th>Department</th><th>Doctor</th><th>Joined</th><th>Wait</th><th>Status</th></tr></thead><tbody>{history.data.map((item) => <tr key={item.id}><td><span className="token-small">Q{String(item.tokenNumber).padStart(3, '0')}</span></td><td>{item.departmentName}</td><td>{item.doctorName}</td><td>{formatDate(item.joinedAt)}</td><td>{item.estimatedWaitMinutes} min</td><td><StatusPill status={item.status} /></td></tr>)}</tbody></table></div></div>}
  </div>}</Secured>;
}
function NotificationsPage() {
  const notices = useListNotifications({ query: { queryKey: getListNotificationsQueryKey(), refetchInterval: 10_000 } });
  const markRead = useMarkNotificationRead();
  const client = useQueryClient();
  const mark = (id: number) => markRead.mutate({ notificationId: id }, { onSuccess: () => {
    client.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
    client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  } });
  return <Secured>{() => <div><PageTitle eyebrow="CLINIC UPDATES" title="Notifications" detail="Queue changes and updates from your care team." />
    {notices.isLoading ? <Skeleton rows={4} /> : notices.isError ? <QueryError retry={() => notices.refetch()} /> : !notices.data?.length ? <div className="panel"><EmptyState title="You’re all caught up" text="New queue updates will appear here." icon={Bell} /></div> :
      <div className="notice-list">{notices.data.map((item) => <article className={cx('notice-item', !item.isRead && 'notice-unread')} key={item.id} data-testid={`notification-${item.id}`}><span className="notice-icon"><Bell size={17} /></span><div className="notice-content"><div className="notice-meta"><b>{item.title}</b><time>{formatDate(item.createdAt)} · {formatTime(item.createdAt)}</time></div><p>{item.message}</p>{item.queueEntryId && <Link className="small-link" href={`/track/${item.queueEntryId}`}>Track this queue <ArrowRight size={13} /></Link>}</div>{!item.isRead && <Button variant="quiet" className="mark-read" disabled={markRead.isPending} onClick={() => mark(item.id)}><Check size={15} /> Mark read</Button>}</article>)}</div>}
  </div>}</Secured>;
}

function useQueueAction() {
  const client = useQueryClient();
  const action = usePerformQueueAction();
  const run = (id: number, actionName: QueueActionInputAction) => action.mutate({ entryId: id, data: { action: actionName } }, { onSuccess: () => {
      client.invalidateQueries({ queryKey: getListQueueEntriesQueryKey() });
      client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      client.invalidateQueries({ queryKey: getGetAnalyticsQueryKey() });
    } });
  return { run, isPending: action.isPending, isError: action.isError };
}
function StaffPage({ doctorMode = false }: { doctorMode?: boolean }) {
  const userQuery = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey(), retry: false } });
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), refetchInterval: 10_000 } });
  const params = useMemo(() => dashboard.data?.queue?.id ? { queueId: dashboard.data.queue.id } : undefined, [dashboard.data?.queue?.id]);
  const entries = useListQueueEntries(params, { query: { queryKey: getListQueueEntriesQueryKey(params), refetchInterval: 5_000, enabled: !!dashboard.data?.queue?.id } });
  const doAction = useQueueAction();
  const simulate = useSimulateQueue();
  const client = useQueryClient();
  if (!userQuery.data) return <Secured>{() => null}</Secured>;
  const permitted = doctorMode ? userQuery.data.role === 'DOCTOR' : ['STAFF', 'ADMIN'].includes(userQuery.data.role);
  const queue = dashboard.data?.queue;
  const list = entries.data ?? dashboard.data?.entries ?? [];
  const active = list.filter((entry) => ['WAITING', 'CALLED', 'IN_CONSULTATION'].includes(entry.status));
  const nextWaiting = active.find((entry) => entry.status === 'WAITING');
  const runSim = (action: SimulationInputAction) => {
    if (!queue) return;
    simulate.mutate({ queueId: queue.id, data: { action } }, { onSuccess: () => {
      client.invalidateQueries({ queryKey: getListQueueEntriesQueryKey() });
      client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      client.invalidateQueries({ queryKey: getGetAnalyticsQueryKey() });
    } });
  };
  return <Secured>{() => !permitted ? <div><PageTitle eyebrow="QUEUE WORKSPACE" title="Access not available" detail="This queue view is limited to clinic team members." /><div className="panel"><EmptyState title="Choose the workspace for your role" text="Your account role determines which clinic tools are available." icon={ShieldCheck} /></div></div> :
    <div><PageTitle eyebrow={doctorMode ? 'CLINICIAN WORKSPACE' : 'FRONT DESK WORKSPACE'} title={doctorMode ? 'Your queue' : 'Queue operations'} detail={queue ? `${queue.departmentName} · ${queue.doctorName}` : 'Live queue activity from your clinic.'} action={<span className="live-updating"><i className="live-dot" /> LIVE UPDATES</span>} />
      {dashboard.isLoading ? <Skeleton rows={4} /> : dashboard.isError ? <QueryError retry={() => dashboard.refetch()} /> : !queue ? <div className="panel"><EmptyState title="No active queue assigned" text="There is no open queue connected to this account." icon={Activity} /></div> :
      <>
        <div className="queue-control-row"><div className="queue-control-main"><span className="queue-icon"><HeartPulse size={19} /></span><div><b>{queue.name}</b><span>{queue.clinicName} · {queue.isOpen ? 'Open' : 'Closed'}</span></div><div className="queue-control-count"><strong>{queue.waitingCount}</strong><small>waiting</small></div></div><div className="queue-control-actions"><Button disabled={!nextWaiting || !queue.isOpen || doAction.isPending} onClick={() => nextWaiting && doAction.run(nextWaiting.id, QueueActionInputAction.CALL_NEXT)}><ArrowRight size={15} /> {doAction.isPending ? 'Updating…' : 'Call next'}</Button></div></div>
        <div className="metrics-grid metrics-three"><Metric label="Waiting" value={queue.waitingCount} icon={Users} note="Patients in line" /><Metric label="Average wait" value={`${dashboard.data?.stats.averageWaitMinutes ?? 0} min`} icon={Clock3} note="Today so far" /><Metric label="Current token" value={queue.currentToken ?? '—'} icon={Activity} note="Now being served" /></div>
        <div className="panel staff-queue-panel"><div className="panel-heading"><div><div className="eyebrow">ACTIVE PATIENTS</div><h2>Live queue <span className="count-tag">{active.length}</span></h2></div><div className="panel-heading-tools"><span className="sync-indicator"><i /> Syncing every 5 sec</span><ListFilter size={16} /></div></div>
          {entries.isLoading ? <Skeleton rows={4} /> : entries.isError ? <QueryError retry={() => entries.refetch()} /> : <EntryTable entries={active} staff onAction={doAction.run} actionPending={doAction.isPending} />}
        </div>
        {!doctorMode && <div className="simulation-row"><div><b>Queue simulation</b><span>Development operations tools</span></div><div><Button variant="outline" disabled={!queue || simulate.isPending} onClick={() => runSim(SimulationInputAction.CONSULTATION)}><RefreshCw size={14} /> Simulate consultation</Button><Button variant="quiet" disabled={!queue || simulate.isPending} onClick={() => runSim(SimulationInputAction.DELAY)}><Clock3 size={14} /> Simulate delay</Button></div></div>}
        {(simulate.isError || doAction.isError) && <p className="inline-error">The queue action could not be completed. Refresh and try again.</p>}
      </>}
    </div>}</Secured>;
}
function AnalyticsPage() {
  const analytics = useGetAnalytics({ query: { queryKey: getGetAnalyticsQueryKey(), refetchInterval: 30_000 } });
  return <Secured>{() => <div><PageTitle eyebrow="CLINIC PERFORMANCE" title="Analytics" detail="Operational insight from your live clinic data." action={<span className="updated-stamp"><i /> Live data</span>} />
    {analytics.isLoading ? <Skeleton rows={5} /> : analytics.isError || !analytics.data ? <QueryError retry={() => analytics.refetch()} /> :
      <><div className="metrics-grid"><Metric label="Patients today" value={analytics.data.stats.patientsToday} icon={Users} note="Total arrivals" /><Metric label="Average wait" value={`${analytics.data.stats.averageWaitMinutes} min`} icon={Clock3} note="Across all queues" /><Metric label="Consultation time" value={`${analytics.data.stats.averageConsultationMinutes} min`} icon={Activity} note="Average duration" /><Metric label="Completed today" value={analytics.data.stats.completedToday} icon={CheckCircle2} note={`${analytics.data.stats.cancelledToday} cancellations`} /></div>
        <div className="analytics-grid"><section className="panel chart-panel"><div className="panel-heading"><div><div className="eyebrow">PATIENT ARRIVALS</div><h2>Hourly volume</h2></div><span className="chart-period">Today</span></div>
          {analytics.data.hourlyVolume.length ? <div className="bar-chart" role="img" aria-label="Hourly patient arrival volume">{analytics.data.hourlyVolume.map((item, index) => { const peak = Math.max(1, ...analytics.data!.hourlyVolume.map((v) => v.count)); return <div className="bar-column" key={`${item.hour}-${index}`}><div className="bar-value">{item.count}</div><div className="bar-track"><i style={{ height: `${Math.max(item.count > 0 ? 8 : 2, item.count / peak * 100)}%` }} /></div><span>{item.hour}</span></div>; })}</div> : <EmptyState title="No arrival data yet" text="Hourly volumes will appear as patients join." />}
        </section><section className="panel chart-panel queue-size-panel"><div className="panel-heading"><div><div className="eyebrow">CURRENT LOAD</div><h2>Queue sizes</h2></div><span className="chart-period">Now</span></div>
          {analytics.data.queueSizes.length ? <div className="queue-bars">{analytics.data.queueSizes.map((item) => { const peak = Math.max(1, ...analytics.data!.queueSizes.map((q) => q.waiting)); return <div className="queue-bar-item" key={item.queueName}><div><span>{item.queueName}</span><b>{item.waiting}</b></div><div className="queue-bar-track"><i style={{ width: `${Math.max(item.waiting ? 5 : 0, item.waiting / peak * 100)}%` }} /></div></div>; })}</div> : <EmptyState title="Queues are clear" text="Queue sizes appear here when people are waiting." />}
        </section></div>
      </>}
  </div>}</Secured>;
}
function AdminPage() {
  const overview = useGetAdminOverview({ query: { queryKey: getGetAdminOverviewQueryKey(), refetchInterval: 20_000 } });
  const directory = useGetDirectory({ query: { queryKey: getGetDirectoryQueryKey(), refetchInterval: 20_000 } });
  return <Secured>{(user) => <div><PageTitle eyebrow="SYSTEM OPERATIONS" title="Admin overview" detail="A live view of people and queues across the clinic." action={<span className="updated-stamp"><i /> Updating</span>} />
    {user.role !== 'ADMIN' ? <div className="panel"><EmptyState title="Administrator access required" text="This operational overview is limited to administrators." icon={ShieldCheck} /></div> :
      overview.isLoading ? <Skeleton rows={5} /> : overview.isError || !overview.data ? <QueryError retry={() => overview.refetch()} /> :
      <><div className="metrics-grid"><Metric label="All users" value={overview.data.userCount} icon={Users} note="Clinic accounts" /><Metric label="Patients" value={overview.data.patientCount} icon={HeartPulse} note="Registered patients" /><Metric label="Staff" value={overview.data.staffCount} icon={Activity} note="Operations team" /><Metric label="Doctors" value={overview.data.doctorCount} icon={Stethoscope} note="Clinical team" /></div>
        <section className="panel admin-queues"><div className="panel-heading"><div><div className="eyebrow">QUEUE NETWORK</div><h2>Departments and availability</h2></div><span className="count-tag">{overview.data.queues.length} queues</span></div>
          {overview.data.queues.length ? <div className="admin-queue-list">{overview.data.queues.map((queue) => <div className="admin-queue-row" key={queue.id}><span className="queue-icon"><HeartPulse size={17} /></span><div className="admin-queue-info"><b>{queue.departmentName}</b><span>{queue.clinicName} · {queue.doctorName}</span></div><span className={cx('open-tag', !queue.isOpen && 'closed-tag')}><i />{queue.isOpen ? 'Open' : 'Closed'}</span><b className="admin-waiting">{queue.waitingCount}<small> waiting</small></b><span className="admin-delay">{queue.delayMinutes > 0 ? `+${queue.delayMinutes} min delay` : 'On schedule'}</span></div>)}</div> : <EmptyState title="No queues configured" text="Queue configuration will appear here." />}
        </section>
        {directory.isError && <p className="muted-small">Directory details are temporarily unavailable.</p>}
      </>}
  </div>}</Secured>;
}
function NotFound() {
  return <main className="not-found"><Brand /><span className="not-found-code">404</span><h1>This page isn’t in the queue.</h1><p>The link may have moved, or the address may be incorrect.</p><Link href="/" className="button button-primary">Return home <ArrowRight size={15} /></Link></main>;
}

function NotificationPreview({ items }: { items: Notification[] }) {
  if (!items?.length) return <div className="panel"><EmptyState title="No recent updates" text="Your clinic’s latest messages will show here." icon={Bell} /></div>;
  return <div className="preview-notices">{items.slice(0, 3).map((item) => <div className="preview-notice" key={item.id}><span className={cx('notice-dot', !item.isRead && 'notice-dot-unread')} /><div><b>{item.title}</b><p>{item.message}</p><small>{formatTime(item.createdAt)}</small></div></div>)}</div>;
}

function RouteView() {
  return <Switch>
    <Route path="/" component={HomePage} />
    <Route path="/sign-in/*?" component={() => <AuthPage mode="sign-in" />} />
    <Route path="/sign-up/*?" component={() => <AuthPage mode="sign-up" />} />
    <Route path="/dashboard" component={DashboardPage} />
    <Route path="/track/:entryId" component={TrackPage} />
    <Route path="/history" component={HistoryPage} />
    <Route path="/analytics" component={AnalyticsPage} />
    <Route path="/notifications" component={NotificationsPage} />
    <Route path="/staff" component={() => <StaffPage />} />
    <Route path="/doctor" component={() => <StaffPage doctorMode />} />
    <Route path="/admin" component={AdminPage} />
    <Route component={NotFound} />
  </Switch>;
}
function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RouteView /></WouterRouter></QueryClientProvider>;
}
export default App;
