import { randomBytes } from "node:crypto";
import type { DeployStatus, RailwayClient } from "./railway.js";

/**
 * The rules live here, away from HTTP and GraphQL:
 * only known images, a hard cap on running containers, and no way to touch a
 * service this app did not create, even with a valid Railway id.
 */
export const NAME_PREFIX = "spinbox-";

export const IMAGES = {
  nginx: "nginx:1.27-alpine",
  redis: "redis:7-alpine",
  whoami: "traefik/whoami:v1.10",
} as const;

export type ImageKey = keyof typeof IMAGES;

export interface Container {
  id: string;
  name: string;
  image: string | null;
  status: DeployStatus | null;
}

export class RuleError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "RuleError";
  }
}

export interface ContainerConfig {
  projectId: string;
  environmentId: string;
  maxContainers: number;
}

export function createContainerService(railway: RailwayClient, config: ContainerConfig) {
  const { projectId, environmentId, maxContainers } = config;

  async function owned() {
    const services = await railway.listServices(projectId);
    return services.filter((service) => service.name.startsWith(NAME_PREFIX));
  }

  return {
    async list(): Promise<Container[]> {
      const services = await owned();
      return Promise.all(
        services.map(async (service) => {
          const instance = await railway.getInstance(service.id, environmentId);
          return { id: service.id, name: service.name, image: instance.image, status: instance.status };
        }),
      );
    },

    async spinUp(imageKey: unknown): Promise<Container> {
      if (typeof imageKey !== "string" || !Object.hasOwn(IMAGES, imageKey)) {
        throw new RuleError("Unknown image", 400);
      }
      const running = await owned();
      if (running.length >= maxContainers) {
        throw new RuleError(`Limit reached: at most ${maxContainers} containers at a time`, 409);
      }
      const image = IMAGES[imageKey as ImageKey];
      const name = `${NAME_PREFIX}${imageKey}-${randomBytes(3).toString("hex")}`;
      const service = await railway.createService({ projectId, environmentId, name, image });
      return { id: service.id, name: service.name, image, status: "QUEUED" };
    },

    async spinDown(id: string): Promise<void> {
      const target = (await owned()).find((service) => service.id === id);
      if (!target) throw new RuleError("No such container", 404);
      await railway.deleteService(target.id, environmentId);
    },
  };
}

export type ContainerService = ReturnType<typeof createContainerService>;
