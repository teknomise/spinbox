/**
 * Thin typed client for the few Railway GraphQL operations Spinbox needs.
 * Query shapes were checked against the public schema at backboard.railway.com.
 */
const ENDPOINT = "https://backboard.railway.com/graphql/v2";

export type DeployStatus =
  | "BUILDING" | "CRASHED" | "DEPLOYING" | "FAILED" | "INITIALIZING" | "NEEDS_APPROVAL"
  | "QUEUED" | "REMOVED" | "REMOVING" | "SKIPPED" | "SLEEPING" | "SUCCESS" | "WAITING";

export interface ServiceSummary {
  id: string;
  name: string;
}

export interface InstanceState {
  image: string | null;
  deploymentId: string | null;
  status: DeployStatus | null;
}

/** Raised for anything Railway refused or answered with an error. */
export class RailwayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RailwayError";
  }
}

export interface RailwayClient {
  listServices(projectId: string): Promise<ServiceSummary[]>;
  getInstance(serviceId: string, environmentId: string): Promise<InstanceState>;
  createService(input: {
    projectId: string;
    environmentId: string;
    name: string;
    image: string;
  }): Promise<ServiceSummary>;
  deleteService(serviceId: string, environmentId: string): Promise<void>;
}

type Fetch = typeof globalThis.fetch;

export function createRailwayClient(token: string, fetchImpl: Fetch = globalThis.fetch): RailwayClient {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new RailwayError(`Could not reach Railway: ${(cause as Error).message}`, 502);
    }
    if (!response.ok) throw new RailwayError(`Railway answered HTTP ${response.status}`, 502);

    const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new RailwayError(body.errors[0]!.message, 502);
    if (body.data === undefined) throw new RailwayError("Railway returned no data", 502);
    return body.data;
  }

  return {
    async listServices(projectId) {
      const data = await gql<{ project: { services: { edges: { node: ServiceSummary }[] } } }>(
        `query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
        { id: projectId },
      );
      return data.project.services.edges.map((edge) => edge.node);
    },

    async getInstance(serviceId, environmentId) {
      const data = await gql<{
        serviceInstance: {
          source: { image: string | null } | null;
          latestDeployment: { id: string; status: DeployStatus } | null;
        };
      }>(
        `query($serviceId: String!, $environmentId: String!) {
          serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
            source { image }
            latestDeployment { id status }
          }
        }`,
        { serviceId, environmentId },
      );
      return {
        image: data.serviceInstance.source?.image ?? null,
        deploymentId: data.serviceInstance.latestDeployment?.id ?? null,
        status: data.serviceInstance.latestDeployment?.status ?? null,
      };
    },

    async createService({ projectId, environmentId, name, image }) {
      const data = await gql<{ serviceCreate: ServiceSummary }>(
        `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
        { input: { projectId, environmentId, name, source: { image } } },
      );
      return data.serviceCreate;
    },

    async deleteService(serviceId, environmentId) {
      await gql<{ serviceDelete: boolean }>(
        `mutation($id: String!, $environmentId: String) { serviceDelete(id: $id, environmentId: $environmentId) }`,
        { id: serviceId, environmentId },
      );
    },
  };
}
