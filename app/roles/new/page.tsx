import Link from "next/link";
import { CreateEmployeeForm } from "../employee-forms";

export default function NewEmployeePage() {
  return (
    <article className="module-body">
      <div className="chat-head">
        <div>
          <h1>添加员工</h1>
          <p className="quiet">保存后写进 roles/。</p>
        </div>
        <Link className="ghost" href="/roles">
          返回
        </Link>
      </div>
      <CreateEmployeeForm />
    </article>
  );
}
