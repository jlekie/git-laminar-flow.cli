import * as _ from 'lodash';

export type ConstructorParams<T, RK extends keyof T = never, OK extends keyof T = never> = Pick<T, RK> & Partial<Pick<T, OK>>;

export type RequiredKeys<T> = { [P in keyof T]-?: undefined extends T[P] ? never : P }[keyof T];
export type OptionalKeys<T> = { [P in keyof T]-?: undefined extends T[P] ? P : never }[keyof T];

export type Delegated<T> = {
    [P in RequiredKeys<T>]-?: () => Required<T>[P]
} & {
    [P in OptionalKeys<T>]+?: () => Required<T>[P]
}
export type DelegatedPreserve<T> = {
    [P in RequiredKeys<T>]-?: () => T[P]
} & {
    [P in OptionalKeys<T>]+?: () => T[P]
}

export type PromisifyAll<T> = {
    [P in keyof T]: Promise<T[P]>
}

export type Lazify<T> = {
    [P in RequiredKeys<T>]-?: Lazy<Required<T>[P]>
} & {
    [P in OptionalKeys<T>]+?: Lazy<Required<T>[P]>
}
export function lazify<T extends Record<string, unknown>>(value: T): Test<T> {
    const tmp: Lazify<T> = _.transform(value, (result, value, key) => {
        result[key] = Lazy.create(value);
    }, {} as any);

    const tmp2 = new LazyHash(tmp);

    return tmp2 as any;
}

export type LazyValue<T> = T extends Lazy<infer VT> ? VT : never;
export type LazyKeys<T> = { [P in keyof T]-?: T[P] extends Lazy<infer VT> ? P : never }[keyof T];
export type Test<T> = {
    [K in LazyKeys<T>]: LazyValue<T[K]>;
} & {
    [K in keyof T]: T[K];
}

export class LazyHash<T> {
    #data: any;

    public constructor(data: Lazify<T>) {
        this.#data = data;

        for (const key in this.#data) {
            if (this.#data[key] instanceof Lazy) {
                Object.defineProperty(this, key, {
                    get: () => { return this.#data[key].value; }
                });
            }
            else {
                Object.defineProperty(this, key, {
                    get: () => { return this.#data[key]; }
                });
            }
        }
    }
}

export class Lazy<T> {
    #handler: () => T;
    #value!: T;
    #resolved: boolean = false;

    public get value(): T {
        if (!this.#resolved)
            this.#value = this.#handler();

        return this.#value;
    }
    public get resolved() {
        return this.#resolved;
    }

    public static create<T>(handler: T | (() => T)) {
        return new Lazy<T>(handler);
    }

    public constructor(handler: T | (() => T)) {
        this.#handler = _.isFunction(handler) ? handler : () => handler;
    }
}
