import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import { get } from "./api/client.ts";
import type { SessionUser } from "./api/types.ts";
import { AppShell } from "./components/AppShell.tsx";
import { Toaster } from "./components/ui.tsx";
import { queryClient } from "./lib/query.ts";

async function currentUser() {
  return queryClient.ensureQueryData({
    queryKey: ["me"],
    queryFn: () => get<{ user: SessionUser | null }>("/auth/me").then((r) => r.user),
    staleTime: 60_000,
  });
}

const rootRoute = createRootRoute({
  component: () => (
    <>
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
  component: lazyRouteComponent(auth, "LoginPage"),
});
const register = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: lazyRouteComponent(auth, "RegisterPage"),
});
const forgot = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: lazyRouteComponent(auth, "ForgotPasswordPage"),
});
const reset = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: z.object({ token: z.string().optional() }),
  component: lazyRouteComponent(auth, "ResetPasswordPage"),
});
const mailbox = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/mailbox",
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
  component: lazyRouteComponent(() => import("./features/dashboard/DashboardPage.tsx"), "DashboardPage"),
});
const newProject = createRoute({
  getParentRoute: () => shell,
  path: "/projects/new",
  component: lazyRouteComponent(() => import("./features/dashboard/NewProjectWizard.tsx"), "NewProjectWizard"),
});
const usage = createRoute({
  getParentRoute: () => shell,
  path: "/usage",
  component: lazyRouteComponent(() => import("./features/usage/UsagePage.tsx"), "UsagePage"),
});
const admin = createRoute({
  getParentRoute: () => shell,
  path: "/admin",
  component: lazyRouteComponent(() => import("./features/admin/AdminPage.tsx"), "AdminPage"),
});
const account = createRoute({
  getParentRoute: () => shell,
  path: "/account",
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
    component: lazyRouteComponent(() => import("./features/project/OverviewPage.tsx"), "OverviewPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/story",
    component: lazyRouteComponent(() => import("./features/story/StoryPage.tsx"), "StoryPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/cast",
    component: lazyRouteComponent(() => import("./features/cast/CastPage.tsx"), "CastPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/cast/$characterId",
    component: lazyRouteComponent(() => import("./features/cast/CharacterDetailPage.tsx"), "CharacterDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/world",
    component: lazyRouteComponent(() => import("./features/world/WorldPage.tsx"), "WorldPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/world/locations/$entityId",
    component: lazyRouteComponent(() => import("./features/world/EntityDetailPage.tsx"), "LocationDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/world/props/$entityId",
    component: lazyRouteComponent(() => import("./features/world/EntityDetailPage.tsx"), "PropDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/chapters",
    component: lazyRouteComponent(() => import("./features/chapters/ChaptersPage.tsx"), "ChaptersPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/chapters/$chapterId",
    component: lazyRouteComponent(() => import("./features/chapters/ChapterDetailPage.tsx"), "ChapterDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/pages",
    validateSearch: chapterSearch,
    component: lazyRouteComponent(() => import("./features/pages/PagesPage.tsx"), "PagesPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/pages/$pageId",
    validateSearch: z.object({ panelId: z.string().optional() }),
    component: lazyRouteComponent(() => import("./features/pages/PageEditorPage.tsx"), "PageEditorPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/generation",
    component: lazyRouteComponent(() => import("./features/generation/GenerationPage.tsx"), "GenerationPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/generation/$jobId",
    component: lazyRouteComponent(() => import("./features/generation/JobDetailPage.tsx"), "JobDetailPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/narration",
    validateSearch: chapterSearch,
    component: lazyRouteComponent(() => import("./features/narration/NarrationPage.tsx"), "NarrationPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/describe",
    component: lazyRouteComponent(() => import("./features/vision/DescribeImagePage.tsx"), "DescribeImagePage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/assets",
    component: lazyRouteComponent(() => import("./features/assets/AssetsPage.tsx"), "AssetsPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/exports",
    component: lazyRouteComponent(() => import("./features/exports/ExportsPage.tsx"), "ExportsPage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/usage",
    component: lazyRouteComponent(() => import("./features/usage/UsagePage.tsx"), "ProjectUsagePage"),
  }),
  createRoute({
    getParentRoute: P,
    path: "/settings",
    component: lazyRouteComponent(() => import("./features/project/SettingsPage.tsx"), "SettingsPage"),
  }),
];

const routeTree = rootRoute.addChildren([
  login,
  register,
  forgot,
  reset,
  mailbox,
  shell.addChildren([dashboard, newProject, usage, admin, account, project.addChildren(projectChildren)]),
]);

export const router = createRouter({ routeTree, basepath: "/app", defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
