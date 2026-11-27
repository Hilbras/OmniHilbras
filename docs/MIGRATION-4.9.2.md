# Migrating to 4.9.2

4.9.2 fixes a model-id routing bug. Problem requests that returned NVIDIA's `404 page not found` now reach the
model you named.

## The collision

NVIDIA publishes model ids namespaced with its own name:

```
nvidia/nemotron-3.5-super-vl-120b-a12b
```

`nvidia` is also its provider id. The gateway read the first segment as a provider prefix and removed it, so
NVIDIA received `nemotron-3.5-super-vl-120b-a12b` and answered **`404 page not found`**. The same model with
the explicit provider prefix worked:

```
nv/nvidia/nemotron-3.5-super-vl-120b-a12b   → 200, 541 ms
nvidia/nemotron-3.5-super-vl-120b-a12b      → 404 page not found
```

Measured 2026-11-27 through the gateway.

## The rule now

**A full id that a connection's catalog lists is the model, not a prefix.** If any connected catalog owns the
entire string, the request is left intact and routing finds the connection that lists it. A provider prefix is
only removed when the whole id is not a catalog entry.

This also fixes the same collision for other vendors: `deepseek/deepseek-v4.1-flash` is a TokenRouter model
whose first segment is also a provider id, and it was at risk of being captured by a DeepSeek connection.

The provider still receives the id its catalog states. NVIDIA's catalog records an upstream `u` value for
some entries, and that value continues to win over both the full id and the bare id.

## No action needed

Existing connections and model ids keep working. Requests that used `nv/…` still do. Requests that used the
bare `nvidia/…` id now succeed instead of returning 404.
