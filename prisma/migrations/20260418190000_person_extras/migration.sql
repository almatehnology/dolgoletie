-- Дополнительные поля человека: пол, место рождения, адрес прописки, код подразделения.
ALTER TABLE "Person" ADD COLUMN "gender" TEXT;
ALTER TABLE "Person" ADD COLUMN "birthPlace" TEXT;
ALTER TABLE "Person" ADD COLUMN "registrationAddress" TEXT;
ALTER TABLE "Person" ADD COLUMN "passportDepartmentCode" TEXT;
