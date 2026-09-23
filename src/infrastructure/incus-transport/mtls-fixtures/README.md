These certificates and keys are public test fixtures. They have no authority outside the loopback HTTPS server in `transport.mtls.test.ts`.

The approved client certificate is signed by `client-ca.pem`. The unapproved client certificate is self-signed. `substitute-server-cert.pem` is a different leaf signed by `server-cert.pem`; this checks that the transport pins the exact server certificate, not only its issuing CA. `other-server-cert.pem` has a name that does not match the loopback endpoint.

The tests read these fixed files and do not need OpenSSL at runtime.
