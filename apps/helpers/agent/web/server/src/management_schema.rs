use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    pub password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Locale {
    pub locale: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueuePage {
    pub cursor: Option<String>,
}
