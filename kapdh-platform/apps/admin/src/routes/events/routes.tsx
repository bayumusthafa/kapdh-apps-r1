import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Manajemen Event & Tiket (F-09, F-15, AC F15-2) dan pemindai check-in (events.checkin). Area events. */
export const eventsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events",
  beforeLoad: guard("/events"),
  component: lazyRouteComponent(() => import("./EventsPages"), "EventsPage"),
});

export const newEventRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events/new",
  beforeLoad: guard("/events/new"),
  component: lazyRouteComponent(() => import("./EventsPages"), "EventEditorPage"),
});

export const eventDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events/$eventId",
  beforeLoad: guard("/events/$eventId"),
  component: lazyRouteComponent(() => import("./EventsPages"), "EventEditorPage"),
});

export const checkinRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events/checkin",
  beforeLoad: guard("/events/checkin"),
  component: lazyRouteComponent(() => import("./EventsPages"), "CheckinPage"),
});

export const eventsRoutes = [eventsRoute, newEventRoute, eventDetailRoute, checkinRoute] as const;
