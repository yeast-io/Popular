#[test]
fn translations_are_complete_and_have_matching_keys() {
    let messages: serde_json::Value =
        serde_json::from_str(include_str!("../../../ui/src/locales/messages.json")).unwrap();
    let en = messages["en-US"].as_object().unwrap();
    let zh = messages["zh-CN"].as_object().unwrap();
    assert_eq!(en.keys().collect::<Vec<_>>(), zh.keys().collect::<Vec<_>>());
    assert!(en
        .values()
        .chain(zh.values())
        .all(|v| v.as_str().is_some_and(|s| !s.is_empty())));
    for code in [
        "invalidUrl",
        "invalidSettings",
        "invalidSecret",
        "targetChanged",
        "credentialError",
        "storageError",
        "runtimeError",
        "timeout",
        "networkError",
        "authenticationError",
        "httpError",
        "invalidResponse",
    ] {
        assert!(en.contains_key(code));
    }
}
