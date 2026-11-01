"""Rule-based recommendation engine: assessment -> pathway, reason, next_action, alternative.

HOW IT WORKS
1. Build "facts" about the item: category, condition, optional functional flag,
   plus traits from ITEM_INFO (repairable / donatable / recyclable / material / routes).
2. Walk RULES from top to bottom. The FIRST rule whose "when" matches wins.
3. Fill that rule's text templates and return them, with the rule's id.
"""

REPAIR = "Repair"
REUSE = "Reuse / Donate"
RECYCLE = "Recycle"
DISCARD = "Discard"
PATHWAYS = {REPAIR, REUSE, RECYCLE, DISCARD}

LOW_CONFIDENCE = 0.5  # below this item-recognition confidence, a "double-check" note is added

# ---------------------------------------------------------------------------
# 1. ITEM KNOWLEDGE
#    Every category has defaults. ITEM_INFO overrides them when a keyword appears
#    in the item name (substring match; the LONGEST matching keyword wins).
# ---------------------------------------------------------------------------
CATEGORY_DEFAULTS = {
    "electronics": {
        "material": "mixed metals, plastics and circuit boards",
        "repairable": True, "donatable": True, "recyclable": True,
        "repair_route": "a local electronics repair shop or the manufacturer's service centre",
        "donate_route": "a charity or refurbisher that accepts working electronics",
        "recycle_route": "a certified e-waste collection point",
    },
    "clothing": {
        "material": "fabric",
        "repairable": True, "donatable": True, "recyclable": True,
        "repair_route": "a tailor or cobbler (or a quick home mend)",
        "donate_route": "a clothing charity or donation bin",
        "recycle_route": "a textile recycling bin",
    },
    "furniture": {
        "material": "wood, metal and fabric",
        "repairable": True, "donatable": True, "recyclable": True,
        "repair_route": "a furniture repair or upholstery workshop",
        "donate_route": "a charity that takes furniture, or a local free-giveaway group",
        "recycle_route": "a bulky-waste recycling service or scrap yard",
    },
    "household": {
        "material": "mixed materials",
        "repairable": False, "donatable": True, "recyclable": True,
        "repair_route": "a local repair café",
        "donate_route": "a charity shop or community swap",
        "recycle_route": "your local recycling centre",
    },
    "other": {
        "material": "unknown materials",
        "repairable": False, "donatable": True, "recyclable": False,
        "repair_route": "a local repair café",
        "donate_route": "a charity shop or community swap",
        "recycle_route": "your local recycling centre",
    },
}

_BIKE = {
    "material": "metal frame and rubber", "repairable": True,
    "repair_route": "a bicycle repair shop or community bike workshop",
    "donate_route": "a bike charity or community bike workshop",
    "recycle_route": "a scrap-metal recycler",
}

ITEM_INFO = {
    # hygiene / safety items: not donatable
    "mattress":   {"material": "foam and springs", "repairable": False, "donatable": False,
                   "recycle_route": "a mattress recycling service or bulky-waste pickup"},
    "pillow":     {"material": "fibre filling", "repairable": False, "donatable": False, "recyclable": False},
    "car seat":   {"material": "plastic, foam and straps", "repairable": False, "donatable": False,
                   "recycle_route": "a car-seat take-back or recycling programme"},
    "helmet":     {"material": "plastic and foam", "repairable": False, "donatable": False, "recyclable": False},
    "underwear":  {"material": "fabric", "repairable": False, "donatable": False},
    # contaminated / no recovery route
    "sponge":     {"material": "foam or cellulose", "repairable": False, "donatable": False, "recyclable": False},
    "toothbrush": {"material": "plastic and nylon", "repairable": False, "donatable": False, "recyclable": False},
    # infant sleep products: safety standards change, so used ones are rarely accepted
    "crib":       {"material": "wood and metal", "repairable": False, "donatable": False},
    "cradle":     {"material": "wood and fabric", "repairable": False, "donatable": False},
    "bassinet":   {"material": "wood, fabric and plastic", "repairable": False, "donatable": False},
    # hygiene / contaminated / no recovery route
    "plunger":    {"material": "rubber and wood", "repairable": False, "donatable": False, "recyclable": False},
    "dishrag":    {"material": "cloth", "repairable": False, "donatable": False, "recyclable": False},
    "plastic bag": {"material": "thin plastic film", "repairable": False, "donatable": False, "recyclable": False},
    "envelope":   {"material": "paper", "repairable": False, "donatable": False},
    "cardboard box": {"material": "cardboard", "repairable": False, "donatable": False,
                      "recycle_route": "a paper and cardboard recycling bin"},
    # hazardous: must never go in the bin
    "battery":    {"material": "lithium or alkaline cells", "repairable": False, "donatable": False,
                   "recycle_route": "a battery drop-off point (many electronics shops have one)"},
    "aerosol can": {"material": "pressurised metal can", "repairable": False, "donatable": False,
                    "recycle_route": "a hazardous-waste collection point (only fully empty cans go to metal recycling)"},
    # ceramics are not accepted in normal recycling
    "mug":        {"material": "ceramic", "recyclable": False},
    "plate":      {"material": "ceramic", "recyclable": False},
    "bowl":       {"material": "ceramic", "recyclable": False},
    # glass is
    "jar":        {"material": "glass", "recyclable": True},
    "bottle":     {"material": "glass or plastic", "recyclable": True},
    # outside the main categories but common
    "bicycle":    _BIKE,
    "bike":       _BIKE,
}

# ---------------------------------------------------------------------------
# 2. RULES  (first match wins, so ORDER MATTERS)
#    "when": fact -> list of allowed values. Facts available:
#        category, condition, functional, repairable, donatable, recyclable
#    Text may use: {item} {category} {condition} {material}
#                  {repair_route} {donate_route} {recycle_route} {recycle_fallback}
# ---------------------------------------------------------------------------
RULES = [
    {
        "id": "no-route",
        "when": {"repairable": [False], "donatable": [False], "recyclable": [False]},
        "pathway": DISCARD,
        "reason": "The {item} ({material}) can't be safely reused or repaired, and it has no common recycling route, so there is no realistic way to recover it.",
        "next_action": "Put it in the general waste bin. Wrap it first if it is sharp or soiled.",
        "alternative": "None realistic. If it is bulky or hazardous, ask your local waste authority about special collection.",
    },
    {
        "id": "electronics-not-working",
        "when": {"category": ["electronics"], "functional": [False]},
        "pathway": RECYCLE,
        "reason": "A non-working {item} contains recoverable metals and hazardous parts ({material}), so it belongs in e-waste recycling, not the bin.",
        "next_action": "Take it to {recycle_route}. Back up and wipe personal data first, and remove any removable battery.",
        "alternative": "Repair, but only if a quote comes in under about half the price of a replacement.",
    },
    {
        "id": "damaged-repairable",
        "when": {"condition": ["damaged"], "repairable": [True]},
        "pathway": REPAIR,
        "reason": "The {item} shows visible damage, but items like this can usually be fixed, and a repair keeps it in use for far less than replacing it.",
        "next_action": "Ask {repair_route} for a quote. Repair is usually worth it if it costs under about half the price of a replacement.",
        "alternative": "If the quote is too high, {recycle_fallback}.",
    },
    {
        "id": "usable-donatable",
        "when": {"condition": ["good", "worn"], "donatable": [True]},
        "pathway": REUSE,
        "reason": "The {item} looks to be in {condition} condition, so it is likely still usable, and someone else can get more life out of it than a recycler can.",
        "next_action": "Clean it, check that everything works (wipe personal data first if it is a device), then give it to {donate_route}.",
        "alternative": "If nobody wants it, {recycle_fallback}.",
    },
    {
        "id": "usable-recycle-only",
        "when": {"condition": ["good", "worn"], "donatable": [False], "recyclable": [True]},
        "pathway": RECYCLE,
        "reason": "The {item} is in {condition} condition, but items like this can't normally be passed on (hygiene, safety or regulatory reasons). Its {material} can still be recovered.",
        "next_action": "Take it to {recycle_route}.",
        "alternative": "If there is no collection point nearby, general waste is the last resort.",
    },
    {
        "id": "damaged-recycle",
        "when": {"condition": ["damaged"], "repairable": [False], "recyclable": [True]},
        "pathway": RECYCLE,
        "reason": "The {item} is visibly damaged and not realistically repairable, but its {material} can be recovered.",
        "next_action": "Take it to {recycle_route}.",
        "alternative": "If it is contaminated or no collection point accepts it, general waste is the fallback.",
    },
    {
        "id": "damaged-discard",
        "when": {"condition": ["damaged"], "repairable": [False], "recyclable": [False]},
        "pathway": DISCARD,
        "reason": "The {item} is damaged, can't realistically be repaired, and its {material} has no common recycling route.",
        "next_action": "Dispose of it with general waste.",
        "alternative": "If it is bulky, ask your local waste authority about a special collection.",
    },
    {
        "id": "unknown-donate",
        "when": {"condition": ["unknown"], "donatable": [True]},
        "pathway": REUSE,
        "reason": "The photo doesn't show the {item}'s condition clearly, so this is a best guess: if it is clean and works, it can be passed on.",
        "next_action": "Check it over first (is anything broken, dirty or not working?). If it is fine, give it to {donate_route}.",
        "alternative": "If it turns out to be damaged, ask {repair_route} about a fix, or {recycle_fallback}.",
    },
    {
        "id": "unknown-recycle",
        "when": {"condition": ["unknown"], "donatable": [False], "recyclable": [True]},
        "pathway": RECYCLE,
        "reason": "The photo doesn't show the {item}'s condition clearly, and items like this can't normally be passed on, so recovering its {material} is the best guess.",
        "next_action": "Check it for damage. If it is beyond saving, take it to {recycle_route}.",
        "alternative": "If it is actually in good shape, consider keeping it.",
    },
    {   # catch-all: keep this LAST
        "id": "fallback",
        "when": {},
        "pathway": DISCARD,
        "reason": "No specific rule covers a {condition} {item} ({category}), so responsible disposal is the safe default.",
        "next_action": "Dispose of it with general waste, or ask your local waste authority if you are unsure.",
        "alternative": "Check whether a local repair café or reuse group would take it.",
    },
]

# ---------------------------------------------------------------------------
# 3. ENGINE (no need to edit below to change behaviour)
# ---------------------------------------------------------------------------
_FACT_KEYS = {"category", "condition", "functional", "repairable", "donatable", "recyclable"}
_TEXT_KEYS = ("reason", "next_action", "alternative")
_SAMPLE_CTX = dict(item="x", category="x", condition="x", material="x",
                   repair_route="x", donate_route="x", recycle_route="x", recycle_fallback="x")


def _check_rules() -> None:
    """Fail at startup (not at request time) if a rule has a typo."""
    for rule in RULES:
        if rule["pathway"] not in PATHWAYS:
            raise ValueError(f"Rule '{rule['id']}': unknown pathway '{rule['pathway']}'")
        bad = set(rule["when"]) - _FACT_KEYS
        if bad:
            raise ValueError(f"Rule '{rule['id']}': unknown fact(s) {bad}")
        for key in _TEXT_KEYS:
            try:
                rule[key].format(**_SAMPLE_CTX)
            except KeyError as e:
                raise ValueError(f"Rule '{rule['id']}': unknown placeholder {e} in '{key}'")


_check_rules()


def get_item_info(item: str, category: str) -> dict:
    info = dict(CATEGORY_DEFAULTS.get(category, CATEGORY_DEFAULTS["other"]))
    name = item.lower()
    matches = [kw for kw in ITEM_INFO if kw in name]
    if matches:
        info.update(ITEM_INFO[max(matches, key=len)])  # longest keyword wins ("headphone" beats "phone")
    return info


def _matches(when: dict, facts: dict) -> bool:
    return all(facts[key] in allowed for key, allowed in when.items())


def recommend(assessment: dict, functional: bool | None = None) -> dict:
    """assessment: {item, category, condition, confidence}. functional: True/False/None (unknown)."""
    item, category, condition = assessment["item"], assessment["category"], assessment["condition"]
    info = get_item_info(item, category)

    facts = {
        "category": category,
        "condition": condition,
        "functional": functional,
        "repairable": info["repairable"],
        "donatable": info["donatable"],
        "recyclable": info["recyclable"],
    }
    ctx = {
        "item": item, "category": category, "condition": condition,
        "material": info["material"],
        "repair_route": info["repair_route"],
        "donate_route": info["donate_route"],
        "recycle_route": info["recycle_route"],
        "recycle_fallback": (f"recycle it at {info['recycle_route']}" if info["recyclable"]
                             else "dispose of it with general waste"),
    }

    rule = next(r for r in RULES if _matches(r["when"], facts))  # the fallback always matches

    reason = rule["reason"].format(**ctx)
    if assessment.get("confidence", 1.0) < LOW_CONFIDENCE:
        reason += f" (The photo analysis was only {assessment['confidence']:.0%} confident, so double-check the item first.)"

    return {
        "pathway": rule["pathway"],
        "reason": reason,
        "next_action": rule["next_action"].format(**ctx),
        "alternative": rule["alternative"].format(**ctx),
        "rule_id": rule["id"],
    }


if __name__ == "__main__":
    samples = [  # (item, category, condition, confidence, works)
        ("wooden chair", "furniture", "damaged", 0.90, None),
        ("old backpack", "clothing", "worn", 0.87, None),
        ("laptop", "electronics", "damaged", 0.85, False),
        ("laptop", "electronics", "damaged", 0.85, None),
        ("phone", "electronics", "worn", 0.90, None),
        ("moldy sponge", "household", "damaged", 0.90, None),
        ("mattress", "furniture", "good", 0.80, None),
        ("mug", "household", "damaged", 0.90, None),
        ("jacket", "clothing", "unknown", 0.30, None),
    ]
    for item, cat, cond, conf, works in samples:
        out = recommend({"item": item, "category": cat, "condition": cond, "confidence": conf}, works)
        print(f"{item:14} [{cat}/{cond}, works={works}] -> {out['pathway']:15} ({out['rule_id']})")
