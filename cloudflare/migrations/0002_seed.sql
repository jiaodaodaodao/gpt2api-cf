insert or ignore into users(id,email,password_hash,role,status,credits,created_at,updated_at)
values('usr_admin','admin@example.com','8ac5c061e5655157b79099046089a0bfe10a53a5a17b41cc18ef1ce1c593740e','admin','active',100000,datetime('now'),datetime('now'));
insert or ignore into system_configs(key,value,description,updated_at) values
('billing.chat.default_cost','1','默认聊天扣费',datetime('now')),
('billing.image.default_cost','5','默认图片扣费',datetime('now')),
('billing.video.default_cost','20','默认视频扣费',datetime('now')),
('proxy.global','','全局代理 URL；Workers 不支持 TCP CONNECT，建议配合上游代理网关',datetime('now'));
