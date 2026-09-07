# Parent stopped-database replay

The parent copied the stopped owned R4 database to a new temporary directory, opened only that copy, enabled read-only transactions, and ran the retained aggregate queries. Query exit0 and the complete output are retained. The original state was not opened or changed by this replay. The temporary copy was removed; no owned copy directory remains.

There are116 lifecycle records and96,452 payload-text bytes. Public tables and indexes total3,440,640 bytes; four sequences add32,768 bytes. These measurements do not identify the allocator responsible for the app memory rise. Earlier transcript reconstruction remains labeled separately.
