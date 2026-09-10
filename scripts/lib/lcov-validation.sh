#!/usr/bin/env bash
# Shared, portable LCOV receipt predicates for coverage producers.

lcov_source_count() {
  awk '/^SF:/{count++} END {print count + 0}' "$1"
}

lcov_has_executable_da() {
  grep -Eq '^DA:[1-9][0-9]*,[0-9]+$' "$1"
}

lcov_has_trusted_producer() {
  grep -Fqx "TN:$2" "$1"
}
