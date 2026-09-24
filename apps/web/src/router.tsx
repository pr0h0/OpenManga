import { useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { get } from "./api/client.ts";
import { qk } from "./api/hooks.ts";
import type { ProjectOverview, SessionUser } from "./api/types.ts";
import { AppShell } from "./components/AppShell.tsx";
import { Toaster } from "./components/ui.tsx";
import { queryClient } from "./lib/query.ts";
import { documentTitle } from "./lib/title.ts";

async function currentUser() {
  return queryClient.ensureQueryData({
    queryKey: ["me"],
    queryFn: () => get<{ user: SessionUser | null }>("/auth/me").then((r) => r.user),
    staleTime: 60_000,
  });
}

/**
 * One owner for document.title: every route carries its own label in staticData, the deepest one wins, and the
 * project name is appended so two tabs open on different projects are told apart.
 */
function DocumentTitle() {
  const matches = useRouterState({ select: (s) => s.matches });
  const label = [...matches]
    .reverse()
    .map((m) => (m.staticData as { title?: string } | undefined)?.title)
    .find(Boolean);
  const projectId = matches.map((m) => (m.params as { projectId?: string }).projectId).find(Boolean);
  // The same key and fetcher as useProject, so the two observers share one request. It must be a real queryFn:
  // an observer carrying skipToken can become the one a refetch uses, and then every refetch of this key rejects
  // with "Missing queryFn" — which is what an invalidation from any job event used to do to the whole project.
  const { data } = useQuery({
    queryKey: qk.project(projectId ?? ""),
    queryFn: () => get<ProjectOverview>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const title = data?.project?.title;
  const film = data?.project?.settings.format === "film";
  useEffect(() => {
    document.title = documentTitle(label, title ? { title, film } : null);
  }, [label, film, title]);
  return null;
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <DocumentTitle />
      <Outlet />
      <Toaster />
    </>
  ),
});

const auth = () => import("./features/auth/AuthPages.tsx");
const login = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: z.object({ next: z.string().optional() }),
  staticData: { title: "Sign in" },
  component: lazyRouteComponent(auth, "LoginPage"),
});
const register = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  staticData: { title: "Create account" },
  component: lazyRouteComponent(auth, "RegisterPage"),
});
const forgot = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  staticData: { title: "Reset password" },
  component: lazyRouteComponent(auth, "ForgotPasswordPage"),
});
const reset = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: z.object({ token: z.string().optional() }),
  staticData: { title: "Set a new password" },
  component: lazyRouteComponent(auth, "ResetPasswordPage"),
});
const mailbox = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/mailbox",
  staticData: { title: "Dev mailbox" },
  component: lazyRouteComponent(() => import("./features/auth/DevMailboxPage.tsx"), "DevMailboxPage"),
});

const shell = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: async ({ location }) => {
    const u = await currentUser().catch(() => null);
    if (!u) throw redirect({ to: "/login", search: { next: location.href } });
  },
  component: AppShell,
});
const dashboard = createRoute({
  getParentRoute: () => shell,
  path: "/",
  staticData: { title: "Projects" },
  component: lazyRouteComponent(() => import("./features/dashboard/DashboardPage.tsx"), "DashboardPage"),
});
const newProject = createRoute({
  getParentRoute: () => shell,
  path: "/projects/new",
  staticData: { title: "New project" },
  component: lazyRouteComponent(() => import("./features/dashboard/NewProjectWizard.tsx"), "NewProjectWizard"),
});
const usage = createRoute({
  getParentRoute: () => shell,
  path: "/usage",
  staticData: { title: "Usage" },
  component: lazyRouteComponent(() => import("./features/usage/UsagePage.tsx"), "UsagePage"),
});
const experts = createRoute({
  getParentRoute: () => shell,
  path: "/experts",
  staticData: { title: "Experts" },
  component: lazyRouteComponent(() => import("./features/experts/ExpertsPage.tsx"), "ExpertsPage"),
});
const expertChat = createRoute({
  getParentRoute: () => shell,
  path: "/experts/$chatId",
  staticData: { title: "Experts" },
  component: lazyRouteComponent(() => import("./features/experts/ExpertsPage.tsx"), "ExpertsPage"),
});
const admin = createRoute({
  getParentRoute: () => shell,
  path: "/admin",
  staticData: { title: "Admin" },
  component: lazyRouteComponent(() => import("./features/admin/AdminPage.tsx"), "AdminPage"),
});
const account = createRoute({
  getParentRoute: () => shell,
  path: "/account",
  staticData: { title: "Account" },
  component: lazyRouteComponent(() => import("./features/account/AccountPage.tsx"), "AccountPage"),
});

const project = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId",
  component: lazyRouteComponent(() => import("./features/project/ProjectLayout.tsx"), "ProjectLayout"),
});
const P = () => project;
const chapterSearch = z.object({ chapterId: z.string().optional() });
const projectChildren = [
  createRoute({
    getParentRoute: P,
    path: "/",
    staticData: { title: "Overview" },
    component: lazyRouteComponent(() => import("./features/project/OverviewPage.tsx"), "OverviewPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/story",
    staticData: { title: "Story" },
    component: lazyRouteComponent(() => import("./features/story/StoryPage.tsx"), "StoryPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/cast",
    staticData: { title: "Cast" },
    component: lazyRouteComponent(() => import("./features/cast/CastPage.tsx"), "CastPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/cast/$characterId",
    staticData: { title: "Character" },
    component: lazyRouteComponent(() => import("./features/cast/CharacterDetailPage.tsx"), "CharacterDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/world",
    staticData: { title: "World" },
    component: lazyRouteComponent(() => import("./features/world/WorldPage.tsx"), "WorldPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/world/locations/$entityId",
    staticData: { title: "Location" },
    component: lazyRouteComponent(() => import("./features/world/EntityDetailPage.tsx"), "LocationDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/world/props/$entityId",
    staticData: { title: "Prop" },
    component: lazyRouteComponent(() => import("./features/world/EntityDetailPage.tsx"), "PropDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/chapters",
    staticData: { title: "Chapters" },
    component: lazyRouteComponent(() => import("./features/chapters/ChaptersPage.tsx"), "ChaptersPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/chapters/$chapterId",
    staticData: { title: "Chapter" },
    component: lazyRouteComponent(() => import("./features/chapters/ChapterDetailPage.tsx"), "ChapterDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/pages",
    validateSearch: chapterSearch,
    staticData: { title: "Pages" },
    component: lazyRouteComponent(() => import("./features/pages/PagesPage.tsx"), "PagesPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/pages/$pageId",
    validateSearch: z.object({ panelId: z.string().optional() }),
    staticData: { title: "Page editor" },
    component: lazyRouteComponent(() => import("./features/pages/PageEditorPage.tsx"), "PageEditorPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/read",
    validateSearch: chapterSearch,
    staticData: { title: "Read" },
    component: lazyRouteComponent(() => import("./features/pages/StripReader.tsx"), "StripReaderPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/generation",
    staticData: { title: "Generation" },
    component: lazyRouteComponent(() => import("./features/generation/GenerationPage.tsx"), "GenerationPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/generation/$jobId",
    staticData: { title: "Job" },
    component: lazyRouteComponent(() => import("./features/generation/JobDetailPage.tsx"), "JobDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/narration",
    validateSearch: chapterSearch,
    staticData: { title: "Narration" },
    component: lazyRouteComponent(() => import("./features/narration/NarrationPage.tsx"), "NarrationPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/describe",
    staticData: { title: "Describe image" },
    component: lazyRouteComponent(() => import("./features/vision/DescribeImagePage.tsx"), "DescribeImagePage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/assets",
    staticData: { title: "Assets" },
    component: lazyRouteComponent(() => import("./features/assets/AssetsPage.tsx"), "AssetsPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/exports",
    staticData: { title: "Exports" },
    component: lazyRouteComponent(() => import("./features/exports/ExportsPage.tsx"), "ExportsPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/usage",
    staticData: { title: "Usage" },
    component: lazyRouteComponent(() => import("./features/usage/UsagePage.tsx"), "ProjectUsagePage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/settings",
    staticData: { title: "Settings" },
    component: lazyRouteComponent(() => import("./features/project/SettingsPage.tsx"), "SettingsPage"),
  }),
];

const routeTree = rootRoute.addChildren([
  login,
  register,
  forgot,
  reset,
  mailbox,
  shell.addChildren([
    dashboard,
    newProject,
    usage,
    experts,
    expertChat,
    admin,
    account,
    project.addChildren(projectChildren),
  ]),
]);

export const router = createRouter({ routeTree, basepath: "/app", defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
