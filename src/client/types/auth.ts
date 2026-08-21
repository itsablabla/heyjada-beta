// Auth-related types

export interface PlatformUser {
    id: string;
    email: string;
    name?: string;
    profilePictureUrl?: string | null;
    isServerOwner?: boolean;
}

export interface AuthStatus {
    anonMode: boolean;
    authenticated: boolean;
    user: PlatformUser | null;
    localAuth?: {
        enabled: boolean;
        needsVerification: boolean;
        authenticated: boolean;
        username: string | null;
    };
    version?: string;
}
