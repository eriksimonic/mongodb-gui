// Stands in for an optional driver module that is not installed. The driver reads it at load time
// and checks for the features it needs, so an empty object lets the app start. The driver reports
// a missing feature only when a command asks for it.
export default {};
