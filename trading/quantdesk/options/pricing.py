"""Black-Scholes-Merton / Black-76 pricing, Greeks, implied volatility, delta-to-strike.

Conventions: sigma as a decimal (0.14), T in years (ACT/365), r and q continuous.
Greeks are per-unit-of-underlying: vega per 1 vol point, theta per calendar day,
rho per 1% rate move. NSE index and stock options are European, so BSM applies directly.
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm

_SQRT2PI = np.sqrt(2 * np.pi)


def _d1d2(S, K, T, r, q, sigma):
    S, K, T, sigma = (np.asarray(x, dtype=float) for x in (S, K, T, sigma))
    sqT = np.sqrt(np.maximum(T, 1e-12))
    sig = np.maximum(sigma, 1e-8)
    d1 = (np.log(S / K) + (r - q + 0.5 * sig ** 2) * T) / (sig * sqT)
    return d1, d1 - sig * sqT, sqT


def bs_price(S, K, T, r, q, sigma, right: str):
    """Vectorised European option price. right: 'CE'/'C' call, 'PE'/'P' put."""
    call = right.upper().startswith("C")
    S_, K_, T_ = (np.asarray(x, dtype=float) for x in (S, K, T))
    d1, d2, _ = _d1d2(S, K, T, r, q, sigma)
    df_r, df_q = np.exp(-r * T_), np.exp(-q * T_)
    if call:
        px = S_ * df_q * norm.cdf(d1) - K_ * df_r * norm.cdf(d2)
        intrinsic = np.maximum(S_ - K_, 0.0)
    else:
        px = K_ * df_r * norm.cdf(-d2) - S_ * df_q * norm.cdf(-d1)
        intrinsic = np.maximum(K_ - S_, 0.0)
    out = np.where(T_ <= 1e-10, intrinsic, np.maximum(px, 0.0))
    return float(out) if np.ndim(out) == 0 else out


def black76_price(F, K, T, r, sigma, right: str):
    """Options on futures: BSM with q = r and S = F."""
    return bs_price(F, K, T, r, r, sigma, right)


def greeks(S, K, T, r, q, sigma, right: str) -> dict:
    call = right.upper().startswith("C")
    S_, K_, T_ = (np.asarray(x, dtype=float) for x in (S, K, T))
    d1, d2, sqT = _d1d2(S, K, T, r, q, sigma)
    sig = np.maximum(np.asarray(sigma, dtype=float), 1e-8)
    df_r, df_q = np.exp(-r * T_), np.exp(-q * T_)
    pdf = np.exp(-0.5 * d1 ** 2) / _SQRT2PI
    gamma = df_q * pdf / (S_ * sig * sqT)
    vega = S_ * df_q * pdf * sqT / 100
    if call:
        delta = df_q * norm.cdf(d1)
        theta = (-S_ * df_q * pdf * sig / (2 * sqT) - r * K_ * df_r * norm.cdf(d2) + q * S_ * df_q * norm.cdf(d1)) / 365
        rho = K_ * T_ * df_r * norm.cdf(d2) / 100
    else:
        delta = -df_q * norm.cdf(-d1)
        theta = (-S_ * df_q * pdf * sig / (2 * sqT) + r * K_ * df_r * norm.cdf(-d2) - q * S_ * df_q * norm.cdf(-d1)) / 365
        rho = -K_ * T_ * df_r * norm.cdf(-d2) / 100
    expired = T_ <= 1e-10
    if np.any(expired):
        itm = (S_ > K_) if call else (S_ < K_)
        delta = np.where(expired, np.where(itm, 1.0 if call else -1.0, 0.0), delta)
        gamma = np.where(expired, 0.0, gamma)
        vega = np.where(expired, 0.0, vega)
        theta = np.where(expired, 0.0, theta)
        rho = np.where(expired, 0.0, rho)
    res = {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta, "rho": rho}
    return {k: float(v) if np.ndim(v) == 0 else v for k, v in res.items()}


def implied_vol(price: float, S: float, K: float, T: float, r: float, q: float, right: str,
                lo: float = 1e-4, hi: float = 5.0) -> float:
    """Newton on vega, falling back to Brent. NaN if the price violates no-arbitrage bounds."""
    if T <= 0:
        return float("nan")
    call = right.upper().startswith("C")
    fwd_intr = max(S * np.exp(-q * T) - K * np.exp(-r * T), 0) if call else max(K * np.exp(-r * T) - S * np.exp(-q * T), 0)
    upper = S * np.exp(-q * T) if call else K * np.exp(-r * T)
    if not (fwd_intr - 1e-9 <= price <= upper + 1e-9):
        return float("nan")
    if price - fwd_intr < 1e-10:
        return lo
    sig = 0.2
    for _ in range(50):
        diff = bs_price(S, K, T, r, q, sig, right) - price
        if abs(diff) < 1e-8:
            return float(sig)
        v = greeks(S, K, T, r, q, sig, right)["vega"] * 100
        if v < 1e-10:
            break
        step = diff / v
        sig_new = sig - step
        if not (lo < sig_new < hi):
            break
        sig = sig_new
    f = lambda s: bs_price(S, K, T, r, q, s, right) - price
    try:
        return float(brentq(f, lo, hi, xtol=1e-10))
    except ValueError:
        return float("nan")


def strike_for_delta(S: float, T: float, r: float, q: float, target_delta: float, right: str,
                     vol_fn=None, sigma: float = 0.15) -> float:
    """Strike whose |delta| equals target_delta; `vol_fn(K)` lets the smile move the answer."""
    vol_fn = vol_fn or (lambda K: sigma)
    call = right.upper().startswith("C")
    tgt = abs(target_delta)

    def f(K):
        d = greeks(S, K, T, r, q, vol_fn(K), right)["delta"]
        return abs(d) - tgt

    lo, hi = S * 0.3, S * 3.0
    try:
        return float(brentq(f, lo, hi, xtol=1e-6 * S))
    except ValueError:
        return S * (1.1 if call else 0.9)
