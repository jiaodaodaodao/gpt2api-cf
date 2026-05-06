declare module 'hono' {
  export type Next = () => Promise<void>;
  export interface Context<E = any> {
    env: E extends { Bindings: infer B } ? B : any;
    req: { path: string; raw: Request; header(name: string): string | undefined; json(): Promise<any>; param(name: string): string; };
    header(name: string, value: string): void;
    json(data: any, status?: number): Response;
    set(key: string, value: any): void;
    get(key: string): any;
  }
  type Handler = (c: Context<any>, next: Next) => Response | Promise<Response | void> | void;
  export class Hono<E = any> {
    fetch: ExportedHandlerFetchHandler<any>;
    use(path: string, ...handlers: Handler[]): this;
    use(...handlers: Handler[]): this;
    get(path: string, ...handlers: Handler[]): this;
    post(path: string, ...handlers: Handler[]): this;
    patch(path: string, ...handlers: Handler[]): this;
    put(path: string, ...handlers: Handler[]): this;
    delete(path: string, ...handlers: Handler[]): this;
    route(path: string, app: Hono<any>): this;
    notFound(handler: Handler): this;
    onError(handler: (err: Error, c: Context<any>) => Response | Promise<Response>): this;
  }
}
declare module 'hono/cors' { export function cors(options?: any): any; }

type D1Result<T = unknown> = { results: T[]; success: boolean; meta: { changes?: number } & Record<string, unknown> };
interface D1PreparedStatement { bind(...values: any[]): D1PreparedStatement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
interface D1Database { prepare(query: string): D1PreparedStatement; batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>; }
interface KVNamespace { get(key: string): Promise<string | null>; put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number; metadata?: Record<string, unknown> }): Promise<void>; }
interface Fetcher { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }
interface ScheduledEvent {}
interface ExecutionContext { waitUntil(promise: Promise<any>): void; passThroughOnException(): void; }
type ExportedHandlerFetchHandler<Env = unknown> = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
