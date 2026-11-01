# Local macOS build of LearnHarness: unsigned Electron build, then a local
# code signature. No Developer ID, no notarization, no Xcode (icon override).
# The release path is `npm run desktop:dist`; see docs/desktop-release.md.

SHELL := /bin/bash
.DEFAULT_GOAL := help

APP      := dist/mac-arm64/LearnHarness.app
ENT      := build/entitlements.mac.plist
ICON     := build/icon.icns
BUNDLE   := com.learnharness.LearnHarness

# Signing identity. `make cert` creates the self-signed one. Use SIGN_ID=- for ad-hoc.
CERT_CN  ?= LearnHarness Local Dev
SIGN_ID  ?= $(CERT_CN)
LOGIN_KC := $(HOME)/Library/Keychains/login.keychain-db

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## npm ci (locked dependencies; run once)
	npm ci

web: ## Next build + server payload checks (the desktop:dist preflight)
	npm run build
	node scripts/smoke-provider-runtime.mjs
	node scripts/build-server.mjs
	node scripts/smoke-server.mjs

pack: ## Package an unsigned .app (no notarization; icon.icns instead of actool)
	rm -rf dist
	CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never \
		-c.mac.notarize=false -c.mac.icon=$(ICON)

# No --options runtime: with the hardened runtime, library validation rejects the
# nested Electron Framework (fatal 309 / "different Team IDs"). Tested on macOS 26.5.1.
sign: ## Sign the .app with SIGN_ID (default: local cert; SIGN_ID=- for ad-hoc)
	@test -d $(APP) || { echo "missing $(APP): run 'make pack' first"; exit 1; }
	@if [ "$(SIGN_ID)" != "-" ] && ! security find-certificate -c "$(SIGN_ID)" >/dev/null 2>&1; then \
		echo "no certificate named '$(SIGN_ID)': run 'make cert' first (or SIGN_ID=- for ad-hoc)"; exit 1; fi
	codesign --force --deep --sign "$(SIGN_ID)" --entitlements $(ENT) $(APP)
	codesign --verify --deep --strict $(APP)

cert: ## Create the local self-signed code-signing cert (one time; macOS may prompt)
	@mkdir -p tmp
	@if security find-certificate -c "$(CERT_CN)" >/dev/null 2>&1; then \
		echo "certificate '$(CERT_CN)' already exists; nothing to do"; \
	else \
		set -e; D=$$(mktemp -d "$(CURDIR)/tmp/lh_codesign.XXXXXX"); trap 'rm -rf "$$D"' EXIT; \
		openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
			-keyout "$$D/key.pem" -out "$$D/cert.pem" -subj "/CN=$(CERT_CN)" \
			-addext "basicConstraints=critical,CA:FALSE" \
			-addext "keyUsage=critical,digitalSignature" \
			-addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null; \
		PW=$$(openssl rand -hex 16); \
		openssl pkcs12 -export -inkey "$$D/key.pem" -in "$$D/cert.pem" -name "$(CERT_CN)" \
			-out "$$D/id.p12" -passout "pass:$$PW"; \
		security import "$$D/id.p12" -k "$(LOGIN_KC)" -P "$$PW" -T /usr/bin/codesign -T /usr/bin/security; \
		echo "created '$(CERT_CN)' (self-signed; not trusted, which codesign does not need)"; \
	fi

app: web pack sign ## Full local build: preflight, package, sign (dist/mac-arm64/LearnHarness.app)

verify: ## Show the signature and designated requirement of the built app
	codesign --verify --deep --strict --verbose=2 $(APP)
	codesign -dv $(APP) 2>&1 | grep -E 'Identifier|Signature|flags'
	codesign -d -r- $(APP) 2>&1 | sed 's/^/  /'

run: ## Open the built app
	@test -d $(APP) || { echo "missing $(APP): run 'make app' first"; exit 1; }
	open -n $(APP)

quit: ## Quit the running app (its server exits with it)
	-osascript -e 'tell application id "$(BUNDLE)" to quit'

clean: ## Remove build output (dist/ and the standalone server payload)
	rm -rf dist .next/standalone

.PHONY: help install web pack sign cert app verify run quit clean
