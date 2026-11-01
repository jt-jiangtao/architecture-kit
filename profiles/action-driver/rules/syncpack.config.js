/** @type {import("syncpack").RcFile} */
export default {
  versionGroups: [
    { label: 'Browser schema v3 compatibility (security migration tracked)', packages: ['@action-driver/browser-runtime'], dependencies: ['zod'], policy: 'sameRange' },
    // Public peer ranges are compatibility contracts, not exact app versions.
    { label: 'Preserve peer compatibility ranges', dependencyTypes: ['peer'], isIgnored: true },
    { label: 'Align exact production and development versions', dependencyTypes: ['prod', 'dev'], specifierTypes: ['exact'], policy: 'sameRange' },
    { label: 'Preserve explicitly declared non-exact ranges', isIgnored: true },
  ],
}
